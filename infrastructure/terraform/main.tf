###############################################################################
# Roxstar backend infrastructure -- Google Cloud (D26).
#
# Cloud Run + Cloud SQL + Artifact Registry + Secret Manager.
#
# Why Cloud Run: it terminates TLS and supports the WebSocket upgrade with no
# separate load balancer to configure, it runs the Docker image the assessment
# already requires, and it scales to zero cost when idle. Kubernetes is
# explicitly out of scope.
#
#   terraform init
#   terraform apply -var project_id=YOUR_PROJECT -var db_password=...
###############################################################################

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

###############################################################################
# APIs
###############################################################################

resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com",
  ])

  service = each.key
  # Keep the APIs enabled if this stack is torn down -- other things may use them.
  disable_on_destroy = false
}

###############################################################################
# Container registry
###############################################################################

resource "google_artifact_registry_repository" "roxstar" {
  location      = var.region
  repository_id = "roxstar"
  format        = "DOCKER"
  description   = "Roxstar backend container images"

  depends_on = [google_project_service.required]
}

###############################################################################
# Database
#
# db-f1-micro is deliberate: this workload is a handful of rooms with a 5-second
# timer, not a throughput problem. Paying for more would be theatre.
###############################################################################

resource "google_sql_database_instance" "roxstar" {
  name             = "roxstar-postgres"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
    }

    ip_configuration {
      # No public IP. Cloud Run reaches the instance through the Cloud SQL
      # connector socket, so the database is never exposed to the internet.
      ipv4_enabled = false
      # Required when ipv4_enabled is false.
      private_network = var.private_network
    }

    database_flags {
      name  = "max_connections"
      value = "100"
    }
  }

  # Guard against `terraform destroy` taking the database with it.
  deletion_protection = var.deletion_protection

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "roxstar" {
  name     = "roxstar"
  instance = google_sql_database_instance.roxstar.name
}

resource "google_sql_user" "app" {
  name     = "roxstar_app"
  instance = google_sql_database_instance.roxstar.name
  password = var.db_password
}

###############################################################################
# Secrets (D29)
#
# Values are never in Terraform state as plaintext literals in the repo, never
# in the image, and never in CI logs. Cloud Run mounts them as env vars at
# start-up.
###############################################################################

resource "google_secret_manager_secret" "database_url" {
  secret_id = "roxstar-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # Unix-socket form used by the Cloud SQL connector.
  secret_data = format(
    "postgres://%s:%s@localhost/%s?host=/cloudsql/%s",
    google_sql_user.app.name,
    var.db_password,
    google_sql_database.roxstar.name,
    google_sql_database_instance.roxstar.connection_name,
  )
}

resource "google_secret_manager_secret" "auth_secret" {
  secret_id = "roxstar-auth-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "auth_secret" {
  secret      = google_secret_manager_secret.auth_secret.id
  secret_data = var.auth_secret
}

###############################################################################
# Runtime identity
#
# Its own service account with exactly two grants: read these secrets, and
# connect to Cloud SQL. Nothing else.
###############################################################################

resource "google_service_account" "runtime" {
  account_id   = "roxstar-run"
  display_name = "Roxstar Cloud Run runtime"
}

resource "google_secret_manager_secret_iam_member" "database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret_iam_member" "auth_secret" {
  secret_id = google_secret_manager_secret.auth_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_project_iam_member" "cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

###############################################################################
# Cloud Run service
###############################################################################

resource "google_cloud_run_v2_service" "backend" {
  name     = "roxstar-backend"
  location = var.region

  # Public: the Android APK connects from arbitrary mobile networks, and
  # authorization is enforced in the application by bearer token (D8/D9).
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.runtime.email

    # D27: pinned to a single instance. Socket.IO fan-out across instances
    # would need a Redis adapter, which is scope this assessment does not call
    # for. The spin timer is already multi-instance-safe (it claims work from
    # the database with FOR UPDATE SKIP LOCKED), so raising max_instance_count
    # later needs only the adapter, not a redesign.
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }

    # Keeps a client's WebSocket pinned to the instance that holds it.
    session_affinity = true
    # WebSockets are long-lived; the default 5-minute request timeout would cut
    # a connection mid-spin.
    timeout = "3600s"

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.roxstar.connection_name]
      }
    }

    containers {
      image = var.image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # The spin scheduler ticks between requests; throttling the CPU when
        # idle would make eliminations land late.
        cpu_idle = false
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        # Unix socket to Cloud SQL -- TLS is handled by the connector, so the
        # application must not also try to negotiate it.
        name  = "DATABASE_SSL"
        value = "false"
      }
      env {
        # D23: empty means deny all browser origins. The APK sends no Origin
        # header and is unaffected.
        name  = "CORS_ALLOWED_ORIGINS"
        value = var.cors_allowed_origins
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "AUTH_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.auth_secret.secret_id
            version = "latest"
          }
        }
      }

      # Liveness only (D32) -- deliberately not /ready, so a brief Cloud SQL
      # blip cannot trigger a restart storm.
      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 12
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [
    google_secret_manager_secret_iam_member.database_url,
    google_secret_manager_secret_iam_member.auth_secret,
    google_project_iam_member.cloudsql_client,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.backend.name
  location = google_cloud_run_v2_service.backend.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

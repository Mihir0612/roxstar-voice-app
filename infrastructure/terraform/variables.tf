variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL and Artifact Registry. Keep them together -- cross-region database calls add latency to every elimination tick."
  type        = string
  default     = "europe-west1"
}

variable "image" {
  description = "Container image to deploy. CI overrides this with a commit-SHA tag so a rollback has an immutable target."
  type        = string
  default     = "europe-west1-docker.pkg.dev/PROJECT/roxstar/roxstar-backend:latest"
}

variable "db_tier" {
  description = "Cloud SQL machine type. A handful of rooms on a 5-second timer does not need more."
  type        = string
  default     = "db-f1-micro"
}

variable "db_password" {
  description = "Password for the application database user. Pass via TF_VAR_db_password or a tfvars file that is NOT committed."
  type        = string
  sensitive   = true
}

variable "auth_secret" {
  description = "HS256 signing secret for session tokens (D8). Minimum 16 characters; generate with `openssl rand -base64 32`."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.auth_secret) >= 16
    error_message = "auth_secret must be at least 16 characters; the backend refuses to start otherwise."
  }
}

variable "private_network" {
  description = "Self-link of the VPC used for the private Cloud SQL IP."
  type        = string
  default     = null
}

variable "cors_allowed_origins" {
  description = "Comma-separated browser origins. EMPTY MEANS DENY ALL (D23). The Android client sends no Origin header and is unaffected."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "Guards the Cloud SQL instance against terraform destroy."
  type        = bool
  default     = true
}

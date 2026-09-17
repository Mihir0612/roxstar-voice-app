output "service_url" {
  description = "Public HTTPS endpoint. This is the value the Android release build must point at -- an APK pointing at localhost is a failed submission."
  value       = google_cloud_run_v2_service.backend.uri
}

output "websocket_url" {
  description = "WebSocket endpoint. Cloud Run terminates TLS, so this is wss:// with no extra configuration."
  value       = replace(google_cloud_run_v2_service.backend.uri, "https://", "wss://")
}

output "health_url" {
  value = "${google_cloud_run_v2_service.backend.uri}/health"
}

output "readiness_url" {
  value = "${google_cloud_run_v2_service.backend.uri}/ready"
}

output "sql_connection_name" {
  description = "Pass to `gcloud run deploy --add-cloudsql-instances`."
  value       = google_sql_database_instance.roxstar.connection_name
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.roxstar.repository_id}"
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "verify_command" {
  description = "Run this after deploying. Uploading is not deploying."
  value       = "node tests/e2e/verify.mjs ${google_cloud_run_v2_service.backend.uri}"
}

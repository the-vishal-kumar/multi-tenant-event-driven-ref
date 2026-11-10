# Connection strings for the four database roles and the JWT signing key.
# Terraform creates the secret containers only; the values are written once
# by the bootstrap step (see README "Deploying"), so no credential is ever in
# Terraform state. Each task's execution role can read only its own secrets.

locals {
  secret_names = toset(["database-url-owner", "database-url-api", "database-url-relay", "database-url-worker", "jwt-secret"])
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.secret_names
  name                    = "${var.name}/${each.key}"
  recovery_window_in_days = 7
}

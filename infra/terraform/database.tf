# Postgres for orders, outbox and dedupe. Aurora Serverless v2 by default;
# a single RDS instance is the cheaper always-on alternative. The master
# password is managed by RDS in Secrets Manager and never enters state.

locals {
  aurora = var.database_mode == "aurora-serverless-v2"

  db_endpoint = local.aurora ? aws_rds_cluster.orders[0].endpoint : aws_db_instance.orders[0].address
}

resource "aws_db_subnet_group" "orders" {
  name       = "${var.name}-db"
  subnet_ids = local.service_subnet_ids
}

resource "aws_rds_cluster" "orders" {
  count = local.aurora ? 1 : 0

  cluster_identifier                  = "${var.name}-db"
  engine                              = "aurora-postgresql"
  engine_mode                         = "provisioned"
  engine_version                      = "17.4"
  database_name                       = "orders"
  master_username                     = "orders_admin"
  manage_master_user_password         = true
  db_subnet_group_name                = aws_db_subnet_group.orders.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  storage_encrypted                   = true
  iam_database_authentication_enabled = true
  backup_retention_period             = 7
  preferred_backup_window             = "03:00-04:00"
  copy_tags_to_snapshot               = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name}-db-final"
  enabled_cloudwatch_logs_exports     = ["postgresql"]

  serverlessv2_scaling_configuration {
    min_capacity             = var.aurora_min_acu
    max_capacity             = var.aurora_max_acu
    seconds_until_auto_pause = var.aurora_min_acu == 0 ? 600 : null
  }
}

resource "aws_rds_cluster_instance" "orders" {
  count = local.aurora ? (var.db_multi_az ? 2 : 1) : 0

  identifier                   = "${var.name}-db-${count.index}"
  cluster_identifier           = aws_rds_cluster.orders[0].id
  engine                       = aws_rds_cluster.orders[0].engine
  engine_version               = aws_rds_cluster.orders[0].engine_version
  instance_class               = "db.serverless"
  db_subnet_group_name         = aws_db_subnet_group.orders.name
  auto_minor_version_upgrade   = true
  performance_insights_enabled = true
}

resource "aws_db_instance" "orders" {
  count = local.aurora ? 0 : 1

  identifier                          = "${var.name}-db"
  engine                              = "postgres"
  engine_version                      = "17"
  instance_class                      = var.rds_instance_class
  allocated_storage                   = 20
  max_allocated_storage               = 100
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = "orders"
  username                            = "orders_admin"
  manage_master_user_password         = true
  db_subnet_group_name                = aws_db_subnet_group.orders.name
  vpc_security_group_ids              = [aws_security_group.db.id]
  multi_az                            = var.db_multi_az
  publicly_accessible                 = false
  iam_database_authentication_enabled = true
  backup_retention_period             = 7
  copy_tags_to_snapshot               = true
  auto_minor_version_upgrade          = true
  deletion_protection                 = var.deletion_protection
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.name}-db-final"
  performance_insights_enabled        = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
}

resource "argocd_application" "media_api" {
  metadata {
    name      = "media-api"
    namespace = "argocd"
  }

  spec {
    project = "byulmaru"

    source {
      repo_url        = "https://github.com/byulmaru/media.git"
      path            = "apps/helm"
      target_revision = "main"

      helm {
        parameter {
          name  = "infisical.projectId"
          value = infisical_project.media.id
        }
        parameter {
          name  = "infisical.identityId"
          value = var.infisical_machine_identity_id
        }
      }
    }


    destination {
      server    = var.argocd_cluster_server
      namespace = var.app_namespace
    }

    sync_policy {
      automated {
        prune     = true
        self_heal = true
      }

      sync_options = ["CreateNamespace=true"]
    }
  }
}

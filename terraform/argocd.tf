provider "argocd" {
  grpc_web = true
}

resource "argocd_application" "media" {
  cascade = false
  wait    = false

  lifecycle {
    # CI owns the release source, image overlay, and enables auto-sync after the ARM build.
    ignore_changes = [
      spec[0].source[0].target_revision,
      spec[0].source[0].helm[0].parameter,
      spec[0].sync_policy[0].automated,
    ]
  }

  metadata {
    name      = "media"
    namespace = "argocd"
  }

  spec {
    project = "media"

    source {
      repo_url        = "https://github.com/byulmaru/media.git"
      target_revision = "main"
      path            = "helm"

      helm {
        release_name = "media"
      }
    }

    destination {
      server    = "https://kubernetes.default.svc"
      namespace = "media"
    }

    sync_policy {
      sync_options = ["CreateNamespace=true"]
    }
  }
}

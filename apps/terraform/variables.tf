variable "cloudflare_account_id" {
  type      = string
  sensitive = true
}

variable "infisical_machine_identity_id" {
  type      = string
  sensitive = true
}

variable "argocd_cluster_server" {
  type        = string
  description = "Kubernetes API server URL for ArgoCD destination"
  default     = "https://kubernetes.default.svc"
}

variable "app_namespace" {
  type        = string
  description = "Kubernetes namespace for media-api"
  default     = "media"
}

resource "infisical_project" "media" {
  name = "media"
  slug = "media"
}

resource "infisical_project_identity" "kubernetes" {
  project_id = infisical_project.media.id
  name       = "kubernetes"
  slug       = "kubernetes"
}
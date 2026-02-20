terraform {
  backend "s3" {
    bucket = "terraform-state"
    key = "media"
    region = "auto"
    use_lockfile = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {}

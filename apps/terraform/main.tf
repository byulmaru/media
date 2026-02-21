terraform {
  backend "s3" {
    bucket       = "terraform-state"
    key          = "media"
    region       = "auto"
    use_lockfile = true
    skip_credentials_validation = true
    skip_region_validation = true
    skip_requesting_account_id = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {}

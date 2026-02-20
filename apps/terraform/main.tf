terraform {
  backend "s3" {
    bucket       = "terraform-state"
    key          = "media"
    # region = auto로 지정하면 validation error 발생!!
    region       = "us-east-1"
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

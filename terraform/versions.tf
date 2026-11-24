terraform {
  required_version = ">= 1.15.7, < 2.0.0"

  backend "oci" {
    auth   = "ResourcePrincipal"
    region = "ap-chuncheon-1"
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22.0"
    }

  }
}

provider "cloudflare" {}

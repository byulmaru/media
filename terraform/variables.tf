variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Worker resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for kos.moe."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be a 32-character hexadecimal Cloudflare zone ID."
  }
}

variable "public_media_domain" {
  description = "Public custom domain connected directly to the media R2 bucket."
  type        = string
  default     = "media.kos.moe"

  validation {
    condition     = var.public_media_domain == "media.kos.moe"
    error_message = "public_media_domain must be media.kos.moe."
  }
}

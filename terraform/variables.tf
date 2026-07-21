variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Worker resources."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "cache_retention_seconds" {
  description = "Age after which objects under cache/ are deleted."
  type        = number
  default     = 30 * 24 * 60 * 60

  validation {
    condition     = var.cache_retention_seconds >= 86400
    error_message = "cache_retention_seconds must be at least one day."
  }
}

output "wrangler_bindings" {
  description = "Values used by the Worker bindings."
  value = {
    r2_bucket_name = cloudflare_r2_bucket.media.name
    public_url     = "https://${cloudflare_r2_custom_domain.media.domain}"
  }
}

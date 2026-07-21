output "wrangler_bindings" {
  description = "Values used by the Worker bindings."
  value = {
    r2_bucket_name  = cloudflare_r2_bucket.media.name
    kv_namespace_id = cloudflare_workers_kv_namespace.remote_images.id
  }
}

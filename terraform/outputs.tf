output "wrangler_bindings" {
  description = "Values to copy into the corresponding Wrangler environment bindings."
  value = {
    for environment, bucket in cloudflare_r2_bucket.media : environment => {
      r2_bucket_name  = bucket.name
      kv_namespace_id = cloudflare_workers_kv_namespace.remote_images[environment].id
    }
  }
}

export const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
);

export const authHeaders = {
  Authorization: "Bearer test-api-key",
  "Content-Type": "application/json",
};

export async function createUpload(
  fetcher: Fetcher,
  limits: Record<string, number> = {},
): Promise<{ id: string; uploadUrl: string; expiresAt: string }> {
  const response = await fetcher.fetch("https://media.example.com/v1/uploads", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(limits),
  });
  if (response.status !== 201) throw new Error(await response.text());
  return response.json();
}

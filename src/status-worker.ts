const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LaptopValue Browser Fetch</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 64px auto; padding: 0 24px; line-height: 1.55; }
    code { background: #f2f2f2; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>LaptopValue Browser Fetch</h1>
  <p>The automated price-fetching service is configured.</p>
  <p>The interactive browser is not hosted by this Worker. It is exposed temporarily at <code>privatebrowser.laptopvalue.co.uk</code> through a Cloudflare Tunnel while the GitHub Actions session is running.</p>
</body>
</html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "browser-fetch-status",
        interactiveBrowser: "https://privatebrowser.laptopvalue.co.uk"
      });
    }

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "cache-control": "public, max-age=300"
      }
    });
  }
};

(() => {
  const isGithubPages = /\.github\.io$/i.test(window.location.hostname);
  const explicitBase = String(window.INVESTOLAB_API_BASE || '').trim();
  const storedBase = String(window.localStorage?.getItem('INVESTOLAB_API_BASE') || '').trim();
  const apiBase = (explicitBase || storedBase).replace(/\/+$/, '');

  window.__INVESTOLAB_API_BASE = apiBase;

  const rawFetch = window.fetch.bind(window);

  function jsonErrorResponse(message, status = 503) {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function resolveApiUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof input.url === 'string') return input.url;
    return null;
  }

  window.fetch = (input, init) => {
    const url = resolveApiUrl(input);
    if (!url || !url.startsWith('/api/')) {
      return rawFetch(input, init);
    }

    if (!apiBase && isGithubPages) {
      return Promise.resolve(
        jsonErrorResponse(
          'Backend API is not configured for GitHub Pages. Set window.INVESTOLAB_API_BASE to your backend URL.'
        )
      );
    }

    const nextUrl = apiBase ? `${apiBase}${url}` : url;
    return rawFetch(nextUrl, init)
      .then((response) => {
        const contentType = String(response.headers?.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
          return jsonErrorResponse(
            'API returned HTML instead of JSON. Check backend URL, deployment, and API route configuration.',
            502
          );
        }
        return response;
      })
      .catch(() =>
        jsonErrorResponse(
          'Unable to reach backend API. Check network, CORS, and backend availability.',
          503
        )
      );
  };
})();

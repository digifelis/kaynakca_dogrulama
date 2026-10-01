(async () => {
  for (const url of ['https://api.ies.ed.gov/eric/?search=title%3A%22Education%21%20Education%21%22&format=json&rows=5', 'https://api.core.ac.uk/v3/search/works?q=title%3A%22Attention%20Is%20All%20You%20Need%22&limit=5']) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json', 'User-Agent': 'KaynakcaMasasi/1.0 (local bibliography verification)' } });
      const body = await response.text();
      console.log(JSON.stringify({ host: new URL(url).hostname, status: response.status, type: response.headers.get('content-type'), location: response.headers.get('location'), body: body.slice(0, 200) }));
    } catch (error) { console.log(JSON.stringify({ host: new URL(url).hostname, error: error.message })); }
  }
})();

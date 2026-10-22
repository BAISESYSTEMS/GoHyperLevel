'use strict';

/** Base URL from the connection ("https://crm.example.com/" → "https://crm.example.com"). */
const baseUrl = (bundle) => String((bundle.authData && bundle.authData.base_url) || '').trim().replace(/\/+$/, '');

/** Adds the API key (and the sub-account for agency keys) to every request. */
const addAuth = (request, z, bundle) => {
  const auth = bundle.authData || {};
  request.headers = request.headers || {};
  if (auth.api_key) request.headers.Authorization = `Bearer ${String(auth.api_key).trim()}`;
  if (auth.location_id) request.headers['x-location-id'] = String(auth.location_id).trim();
  request.headers.Accept = 'application/json';
  if (request.body && typeof request.body === 'object') request.headers['Content-Type'] = 'application/json';
  return request;
};

/** Readable German errors instead of a bare status code. */
const handleErrors = (response, z) => {
  if (response.status < 400 || (response.request && response.request.skipThrowForStatus)) return response;
  let message = '';
  try {
    message = (response.data && response.data.error) || JSON.parse(response.content || '{}').error || '';
  } catch (e) {
    message = '';
  }
  if (response.status === 401) throw new z.errors.Error(message || 'API-Schlüssel ungültig – bitte die Verbindung prüfen.', 'AuthenticationError', 401);
  if (response.status === 403) throw new z.errors.Error(message || 'Keine Berechtigung für diese Aktion.', 'Forbidden', 403);
  if (response.status === 404) throw new z.errors.Error(message || 'Nicht gefunden.', 'NotFound', 404);
  throw new z.errors.Error(message || `HyperLevel antwortet mit ${response.status}.`, 'ApiError', response.status);
};

/** Removes empty values so optional Zapier fields don't overwrite data with "". */
const compact = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  return out;
};

module.exports = { baseUrl, addAuth, handleErrors, compact };

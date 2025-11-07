/**
 * Centralized API Client Module
 * Handles all external API calls with rate limiting, caching, and error handling
 */

class ApiClient {
  constructor() {
    this.baseUrls = {
      printful: 'https://api.printful.com',
      printify: 'https://api.printify.com/v1',
      netlify: '/.netlify/functions'
    };
    
    this.cache = new Map();
    this.cacheExpiry = new Map();
    this.rateLimits = new Map();
    this.requestQueue = new Map();
    
    // Rate limiting configuration
    this.rateLimitConfig = {
      printful: { maxRequests: 120, windowMs: 60000 }, // 120 requests per minute
      printify: { maxRequests: 100, windowMs: 60000 }  // 100 requests per minute
    };
    
    this.defaultCacheTtl = 5 * 60 * 1000; // 5 minutes
  }
  
  // Generic Printful proxy caller
  async printfulProxy(endpoint, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body = null
    } = options;
    const payload = {
      endpoint,
      method,
      headers,
      ...(method === 'GET' ? {} : { body })
    };
    const resp = await this.netlify('printful-proxy', payload);
    // Netlify proxy returns { success, data } or { success:false, error }
    if (resp && resp.success) {
      return resp.data;
    }
    // If already a raw payload (e.g., local dev), return as-is
    if (resp && (resp.data || resp.result)) return resp.data || resp.result;
    throw new Error(`Printful proxy error${resp?.error ? `: ${resp.error}` : ''}`);
  }
  
  /**
   * Generic HTTP request with rate limiting and caching
   */
  async request(service, endpoint, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body = null,
      cache = true,
      cacheTtl = this.defaultCacheTtl,
      retries = 3,
      timeout = 30000
    } = options;
    
    const url = `${this.baseUrls[service]}${endpoint}`;
    const cacheKey = `${method}:${url}:${JSON.stringify(body)}`;
    
    // Check cache first for GET requests
    if (method === 'GET' && cache && this.isCacheValid(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    
    // Check rate limits
    await this.checkRateLimit(service);
    
    // Prepare request
    const requestOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      signal: AbortSignal.timeout(timeout)
    };
    
    if (body && method !== 'GET') {
      requestOptions.body = JSON.stringify(body);
    }
    
    // Execute request with retries
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, requestOptions);
        
        // Update rate limit info
        this.updateRateLimit(service, response.headers);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        // Cache successful GET requests
        if (method === 'GET' && cache) {
          this.setCache(cacheKey, data, cacheTtl);
        }
        
        return data;
        
      } catch (error) {
        lastError = error;
        
        // Don't retry on certain errors
        if (error.name === 'AbortError' || 
            (error.message && error.message.includes('HTTP 4'))) {
          break;
        }
        
        // Wait before retry
        if (attempt < retries) {
          await this.delay(Math.pow(2, attempt) * 1000);
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Printful API methods
   */
  async printful(endpoint, options = {}) {
    // Route through Netlify proxy to leverage OAuth + token refresh
    return this.printfulProxy(endpoint, options);
  }
  
  // v2-first Catalog helpers via proxy
  async getCatalogProductsV2(params = {}, options = {}) {
    const qs = new URLSearchParams({
      // OAuth tokens don't support selling_region_name - removed
      ...(params.limit ? { limit: String(params.limit) } : {}),
      ...(params.page ? { page: String(params.page) } : {}),
      ...(params.search ? { search: String(params.search) } : {}),
      // Include DSR (Default Selling Region) filter when provided
      ...(params.selling_region ? { selling_region: String(params.selling_region) } : {})
    }).toString();
    const endpoint = `/v2/catalog-products${qs ? `?${qs}` : ''}`;
    const res = await this.printfulProxy(endpoint, { method: 'GET', headers: options.headers || {} });
    return this.extractArrayFromResponse(res);
  }
  
  async getCatalogProductV2(id, params = {}, options = {}) {
    // OAuth tokens don't support selling_region_name - use endpoint without it
    const endpoint = `/v2/catalog-products/${encodeURIComponent(String(id))}`;
    const res = await this.printfulProxy(endpoint, { method: 'GET', headers: options.headers || {} });
    return res;
  }
  
  // Legacy v1 fallbacks via proxy
  async getCatalogProductV1(id, options = {}) {
    const endpoint = `/products/${encodeURIComponent(String(id))}`;
    const res = await this.printfulProxy(endpoint, { method: 'GET', headers: options.headers || {} });
    return res?.result ?? res?.data ?? res;
  }
  
  async getPrintfulProductV1(id, options = {}) {
    // For print_files details used in print areas UI
    return this.getCatalogProductV1(id, options);
  }
  
  async getPrintfilesV1(catalogProductId, options = {}) {
    const endpoint = `/mockup-generator/printfiles/${encodeURIComponent(String(catalogProductId))}`;
    const res = await this.printfulProxy(endpoint, { method: 'GET', headers: options.headers || {} });
    // printfiles shape varies; expose raw and common locations
    return res?.result ?? res?.data ?? res;
  }
  
  async createPrintfulProduct(payload) {
    // Use server function that handles uploads + creation + optional images
    const res = await this.netlify('printful-create-product', payload);
    return res;
  }
  
  /**
   * Printify API methods
   */
  async printify(endpoint, options = {}) {
    return this.request('printify', endpoint, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.getPrintifyToken()}`,
        ...options.headers
      }
    });
  }
  
  async getPrintifyProducts() {
    return this.printify('/catalog/blueprints.json');
  }
  
  async getPrintifyProduct(id) {
    return this.printify(`/catalog/blueprints/${id}.json`);
  }
  
  async createPrintifyProduct(shopId, data) {
    return this.printify(`/shops/${shopId}/products.json`, {
      method: 'POST',
      body: data,
      cache: false
    });
  }
  
  /**
   * Netlify Functions methods - integrated with existing functions
   */
  async netlify(functionName, data = {}) {
    return this.request('netlify', `/${functionName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.getAuthToken() || ''}`
      },
      body: data,
      cache: false
    });
  }
  
  /**
   * Generate AI content using existing generate-content function
   * Supports: title, description, tags, key-features, materials, product-content
   */
  async generateContent(prompt, options = {}) {
    const {
      contentType = 'product-content',
      style,
      colors,
      audience,
      productId,
      productInfo
    } = options;
    
    return this.netlify('generate-content', {
      prompt,
      contentType,
      style,
      colors,
      audience,
      productId,
      productInfo
    });
  }
  
  /**
   * Generate product titles using AI
   */
  async generateProductTitle(prompt, productInfo = null) {
    return this.generateContent(prompt, {
      contentType: 'title',
      productInfo
    });
  }
  
  /**
   * Generate product descriptions using AI
   */
  async generateProductDescription(prompt, options = {}) {
    return this.generateContent(prompt, {
      contentType: 'description',
      ...options
    });
  }
  
  /**
   * Generate product tags using AI
   */
  async generateProductTags(prompt, productInfo = null) {
    return this.generateContent(prompt, {
      contentType: 'tags',
      productInfo
    });
  }
  
  /**
   * Generate key features using AI
   */
  async generateKeyFeatures(prompt, productInfo = null) {
    return this.generateContent(prompt, {
      contentType: 'key-features',
      productInfo
    });
  }
  
  /**
   * Generate materials list using AI
   */
  async generateMaterials(prompt, productInfo = null) {
    return this.generateContent(prompt, {
      contentType: 'materials',
      productInfo
    });
  }
  
  /**
   * Generate complete product content (all fields) using AI
   */
  async generateCompleteProductContent(prompt, options = {}) {
    return this.generateContent(prompt, {
      contentType: 'product-content',
      ...options
    });
  }
  
  /**
   * Generate mockup gallery using existing generate-mockup-gallery function
   */
  async generateMockupGallery(productData) {
    const {
      catalog_product_id,
      placement_files,
      count = 10,
      product_options
    } = productData;
    
    return this.netlify('generate-mockup-gallery', {
      catalog_product_id,
      placement_files,
      count,
      ...(Array.isArray(product_options) && product_options.length ? { product_options } : {})
    });
  }
  
  /**
   * Add model using existing add-model function
   */
  async addModel(modelData) {
    return this.netlify('add-model', modelData);
  }
  
  /**
   * Rate limiting management
   */
  async checkRateLimit(service) {
    const config = this.rateLimitConfig[service];
    if (!config) return;
    
    const now = Date.now();
    const windowStart = now - config.windowMs;
    
    // Get or create rate limit tracker
    if (!this.rateLimits.has(service)) {
      this.rateLimits.set(service, []);
    }
    
    const requests = this.rateLimits.get(service);
    
    // Remove old requests outside the window
    const validRequests = requests.filter(time => time > windowStart);
    this.rateLimits.set(service, validRequests);
    
    // Check if we're at the limit
    if (validRequests.length >= config.maxRequests) {
      const oldestRequest = Math.min(...validRequests);
      const waitTime = oldestRequest + config.windowMs - now;
      
      if (waitTime > 0) {
        await this.delay(waitTime);
        return this.checkRateLimit(service); // Recursive check
      }
    }
    
    // Record this request
    validRequests.push(now);
  }
  
  updateRateLimit(service, headers) {
    const remaining = headers.get('X-RateLimit-Remaining');
    const reset = headers.get('X-RateLimit-Reset');
    
    if (remaining !== null || reset !== null) {
      // Update state manager with rate limit info
      if (window.StateManager) {
        window.StateManager.updateState({
          rateLimits: {
            [service]: {
              remaining: remaining ? parseInt(remaining) : null,
              resetTime: reset ? parseInt(reset) * 1000 : null
            }
          }
        });
      }
    }
  }
  
  /**
   * Cache management
   */
  setCache(key, data, ttl) {
    this.cache.set(key, data);
    this.cacheExpiry.set(key, Date.now() + ttl);
  }
  
  isCacheValid(key) {
    if (!this.cache.has(key)) return false;
    
    const expiry = this.cacheExpiry.get(key);
    if (Date.now() > expiry) {
      this.cache.delete(key);
      this.cacheExpiry.delete(key);
      return false;
    }
    
    return true;
  }
  
  clearCache(pattern = null) {
    if (pattern) {
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key);
          this.cacheExpiry.delete(key);
        }
      }
    } else {
      this.cache.clear();
      this.cacheExpiry.clear();
    }
  }
  
  /**
   * Utility methods
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getAuthToken() {
    try {
      return localStorage.getItem('authToken');
    } catch (_) {
      return null;
    }
  }
  
  getPrintfulToken() {
    // In production, this should come from secure storage
    return localStorage.getItem('printful_token') || process.env.PRINTFUL_TOKEN;
  }
  
  setPrintfulToken(token) {
    localStorage.setItem('printful_token', token);
  }
  
  getPrintifyToken() {
    // In production, this should come from secure storage
    return localStorage.getItem('printify_token') || process.env.PRINTIFY_TOKEN;
  }
  
  setPrintifyToken(token) {
    localStorage.setItem('printify_token', token);
  }
  
  /**
   * Batch requests for efficiency
   */
  async batchRequest(requests) {
    const results = await Promise.allSettled(
      requests.map(({ service, endpoint, options }) => 
        this.request(service, endpoint, options)
      )
    );
    
    return results.map((result, index) => ({
      ...requests[index],
      success: result.status === 'fulfilled',
      data: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason : null
    }));
  }
  
  /**
   * Health check for all services
   */
  async healthCheck() {
    const checks = [
      { service: 'printful', endpoint: '/products', name: 'Printful API' },
      { service: 'printify', endpoint: '/catalog/blueprints.json', name: 'Printify API' }
    ];
    
    const results = await Promise.allSettled(
      checks.map(check => 
        this.request(check.service, check.endpoint, { timeout: 5000 })
          .then(() => ({ ...check, status: 'healthy' }))
          .catch(error => ({ ...check, status: 'error', error: error.message }))
      )
    );
    
    return results.map(result => 
      result.status === 'fulfilled' ? result.value : result.reason
    );
  }
}

// Create singleton instance
const apiClient = new ApiClient();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = apiClient;
} else if (typeof window !== 'undefined') {
  window.ApiClient = apiClient;
}

export default apiClient;

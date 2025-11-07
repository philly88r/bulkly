/**
 * bulk-creator-functions.js
 * 
 * Updated to align with official Printful API v1 and v2 documentation.
 * Manages the application state, navigation, API calls, and UI updates 
 * for the bulk product creation workflow.
 */

// Force cache refresh on page load (skip during OAuth redirects)
(function forceCacheRefresh() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') || params.has('state')) {
    return; // skip refresh during OAuth callback
  }
  const lastRefresh = localStorage.getItem('last_page_refresh');
  const now = Date.now();
  const refreshInterval = 5 * 60 * 1000; // 5 minutes
  if (!lastRefresh || (now - parseInt(lastRefresh)) > refreshInterval) {
    localStorage.setItem('last_page_refresh', now.toString());
    const url = new URL(window.location.href);
    url.searchParams.set('cache_bust', String(now));
    window.history.replaceState({}, document.title, url.toString());
  }
})();

// Handle Etsy OAuth PKCE return (code + state in URL)
(async function handleEtsyOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return;

  try {
    const expectedState = localStorage.getItem('etsy_oauth_state');
    const codeVerifier = localStorage.getItem('etsy_code_verifier');
    const redirectUri = window.location.origin + '/bulkly.html';

    if (!expectedState || state !== expectedState) {
      console.error('[ETSY] OAuth state mismatch');
      alert('❌ Etsy OAuth failed: state mismatch. Please try again.');
      return;
    }
    if (!codeVerifier) {
      console.error('[ETSY] Missing code_verifier in storage');
      alert('❌ Etsy OAuth failed: missing code verifier. Please try again.');
      return;
    }

    // Exchange code for token
    const res = await fetch('/.netlify/functions/etsy-exchange-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) {
      console.error('[ETSY] Token exchange failed', data);
      alert('❌ Etsy OAuth failed during token exchange. Check console.');
      return;
    }

    // Persist token
    localStorage.setItem('etsy_access_token', data.access_token);
    if (data.refresh_token) {
      localStorage.setItem('etsy_refresh_token', data.refresh_token);
    }

    // Cleanup URL params
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    window.history.replaceState({}, document.title, url.toString());

    // Update the auth button to show connected status
    updateEtsyAuthButton();

    // Mark that we should resume the action if a product was selected before OAuth
    const resumeId = localStorage.getItem('etsy_resume_db_id');
    if (resumeId) {
      localStorage.setItem('etsy_resume_pending', '1');
      // Try immediate resume if the DOM is ready
      const card = document.querySelector(`[data-product-id="${resumeId}"]`) || document.querySelector(`.etsy-btn[data-db-id="${resumeId}"]`)?.closest('.card');
      if (card) {
        try { await sendToEtsy(card); } catch (e) { console.error('[ETSY] Immediate resume failed', e); }
      }
    }

    alert('✅ Etsy connected! You can now send products to Etsy.');
  } catch (e) {
    console.error('[ETSY] OAuth handling error', e);
    alert('❌ Etsy OAuth error. See console for details.');
  }
})();

// ============================================================================
// 1. GLOBAL STATE AND INITIALIZATION
// ============================================================================

let state = {
  currentStep: 2, // Start at Step 2: Product Selection
  completedSteps: new Set(),
  selectedProducts: new Set(),
  selectedShop: null,
  productDesigns: {},
};

let allProducts = [];
let filteredProducts = [];
let createdProducts = [];
let currentPage = 1;
const productsPerPage = 12;

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2
};

document.addEventListener('DOMContentLoaded', init);

/**
 * Update Etsy auth button status based on whether token exists
 */
function updateEtsyAuthButton() {
  const etsyToken = localStorage.getItem('etsy_access_token');
  const etsyAuthBtn = document.getElementById('etsyAuthBtn');
  const etsyAuthBtnText = document.getElementById('etsyAuthBtnText');

  if (etsyAuthBtn && etsyAuthBtnText) {
    if (etsyToken) {
      etsyAuthBtn.classList.remove('btn-outline-warning');
      etsyAuthBtn.classList.add('btn-success');
      etsyAuthBtnText.textContent = 'Etsy Connected';
    } else {
      etsyAuthBtn.classList.remove('btn-success');
      etsyAuthBtn.classList.add('btn-outline-warning');
      etsyAuthBtnText.textContent = 'Connect Etsy';
    }
  }
}

/**
 * Initiates Etsy OAuth authorization flow
 */
async function authorizeEtsy() {
  try {
    console.log('[ETSY-AUTH] Starting OAuth flow...');
    const startRes = await fetch('/.netlify/functions/etsy-oauth-start');
    const startData = await startRes.json().catch(() => ({}));

    if (!startRes.ok || !startData?.success || !startData?.auth_url || !startData?.code_verifier) {
      throw new Error('Failed to initiate Etsy OAuth. Please try again.');
    }

    // Persist PKCE details
    localStorage.setItem('etsy_oauth_state', startData.state);
    localStorage.setItem('etsy_code_verifier', startData.code_verifier);

    // Redirect user to Etsy
    console.log('[ETSY-AUTH] Redirecting to Etsy...');
    window.location.href = startData.auth_url;
  } catch (err) {
    console.error('[ETSY-AUTH] Error:', err);
    alert(`❌ Failed to start Etsy authorization: ${err.message}`);
  }
}

/**
 * Initializes the application on page load.
 */
async function init() {
  console.log('Initializing Bulk Creator...');
  const token = localStorage.getItem('authToken');
  if (!token) {
    window.location.href = '/auth.html';
    return;
  }

  // Update Etsy authorization button status
  updateEtsyAuthButton();

  // Initialize store dropdown early so user can pick the target store
  try {
    await initializeStoreDropdown();
  } catch (e) {
    console.warn('Store dropdown initialization failed:', e);
  }

  // Restore state from sessionStorage if available
  try {
    const savedState = sessionStorage.getItem('bulklyState');
    if (savedState) {
      const parsedState = JSON.parse(savedState);
      // Convert Set-like array back to Set
      if (parsedState.selectedProducts) {
        parsedState.selectedProducts = new Set(parsedState.selectedProducts);
      }
      if (parsedState.completedSteps) {
        parsedState.completedSteps = new Set(parsedState.completedSteps);
      }
      state = { ...state, ...parsedState };
    }
  } catch (e) {
    console.warn('Could not restore state from sessionStorage', e);
    sessionStorage.removeItem('bulklyState'); // Clear corrupted state
  }

  // Set the initial step based on restored state
  navigateToStep(state.currentStep);
  await initializeStep(state.currentStep);
}

// ============================================================================
// Store Selection (Navbar)
// ============================================================================

/**
 * Loads available Printful stores and populates the navbar dropdown.
 * Uses the proper v1 API endpoint for stores.
 */
async function initializeStoreDropdown() {
  const select = document.getElementById('storeSelect');
  if (!select) return; // Page without dropdown

  const setPlaceholder = (text, disabled = true) => {
    select.innerHTML = `<option ${disabled ? 'selected disabled' : ''}>${text}</option>`;
    select.disabled = disabled;
  };

  try {
    setPlaceholder('Loading stores...');

    // Use v1 stores endpoint as documented
    const storesRes = await makeApiCall('/stores');
    console.log('Stores API response:', storesRes);
    
    let stores = [];
    // Handle v1 response structure: { code: 200, result: [...] }
    if (storesRes && Array.isArray(storesRes.result)) {
      stores = storesRes.result;
    } else if (Array.isArray(storesRes)) {
      stores = storesRes;
    }

    const savedId = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_store_id')) || '';

    if (!Array.isArray(stores) || stores.length === 0) {
      setPlaceholder('No stores found', true);
      try { localStorage.removeItem('pf_store_id'); } catch {}
      return;
    }

    // Build options with proper store structure
    const options = [];
    options.push('<option value="" disabled>Select a store…</option>');
    for (const s of stores) {
      const id = String(s.id ?? '');
      const name = String(s.name ?? `Store ${id}`);
      if (!id) continue;
      const selectedAttr = savedId && savedId === id ? ' selected' : '';
      options.push(`<option value="${id}"${selectedAttr}>${name} (ID: ${id})</option>`);
    }

    select.innerHTML = options.join('');
    select.disabled = false;

    // Handle selection persistence
    if (savedId) {
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === savedId) {
          select.selectedIndex = i;
          break;
        }
      }
    } else if (select.options.length > 1) {
      select.selectedIndex = 1;
      const chosen = select.value;
      try { localStorage.setItem('pf_store_id', chosen); } catch {}
    }

    select.addEventListener('change', () => {
      const val = select.value;
      try {
        if (val) {
          localStorage.setItem('pf_store_id', val);
        } else {
          localStorage.removeItem('pf_store_id');
        }
      } catch {}
    });

  } catch (error) {
    console.warn('Failed to load stores:', error?.message || error);
    setPlaceholder('Failed to load stores', true);
  }
}

/**
 * Persists the current state to sessionStorage.
 */
function saveState() {
  try {
    const stateToSave = {
      ...state,
      selectedProducts: Array.from(state.selectedProducts),
      completedSteps: Array.from(state.completedSteps),
    };
    sessionStorage.setItem('bulklyState', JSON.stringify(stateToSave));
  } catch (e) {
    console.warn('Could not save state to sessionStorage', e);
  }
}

/**
 * Resets the current state.
 */
function resetState() {
  try {
    sessionStorage.removeItem('bulklyState');
    localStorage.removeItem('pf_selling_region');
    // Clear the state object
    state = {
      currentStep: 2, // Start at Step 2: Product Selection
      completedSteps: new Set(),
      selectedProducts: new Set(),
      allProducts: [],
      filteredProducts: [],
      productFilters: {
        category: '',
        type: '',
        brand: '',
        searchTerm: ''
      },
      printAreas: new Map(),
      selectedImages: new Map(),
      generatedDesigns: new Map(),
      generationProgress: new Map(),
      createdProducts: [],
      publishingProgress: new Map(),
      step5Overrides: {},
      step5PlacementOverrides: {},
      productOptions: {},
      loading: false,
      error: null,
      modals: {
        imageSelection: false,
        designPreview: false,
        pricing: false
      },
      rateLimits: {
        printful: { remaining: 120, resetTime: null },
        printify: { remaining: 100, resetTime: null }
      },
      productDesigns: {},
      productContent: {},
      generatedImages: {}
    };
    console.log('State reset successfully');
  } catch (e) {
    console.warn('Could not reset state', e);
  }
}

// ============================================================================
// 2. AUTH & NAVIGATION
// ============================================================================

/**
 * Logs the user out by clearing credentials and redirecting.
 */
function logout() {
  localStorage.removeItem('authToken');
  sessionStorage.clear();
  window.location.href = '/auth.html';
}

/**
 * Navigates the UI to a specific step.
 * @param {number} stepNumber - The step to navigate to (2-5).
 */
function navigateToStep(stepNumber) {
  if (stepNumber < 2 || stepNumber > 5) return;

  state.currentStep = stepNumber;
  saveState();

  // Update step indicators
  document.querySelectorAll('.step').forEach(el => {
    const step = parseInt(el.getAttribute('onclick').match(/\d+/)[0]);
    el.classList.remove('active', 'completed');
    if (state.completedSteps.has(step) || step < state.currentStep) {
      el.classList.add('completed');
    }
    if (step === state.currentStep) {
      el.classList.add('active');
    }
  });

  // Show the correct step container
  document.querySelectorAll('.step-container').forEach(el => el.classList.remove('active'));
  const container = document.getElementById(`step${stepNumber}-container`);
  if (container) {
    container.classList.add('active');
  }

  // Initialize the logic for the new step
  initializeStep(stepNumber);
}

/**
 * Initializes the logic for the current step.
 * @param {number} stepNumber - The step to initialize.
 */
async function initializeStep(stepNumber) {
  console.log(`Initializing logic for Step ${stepNumber}`);
  switch (stepNumber) {
    case 2:
      await loadProductsForShop();
      initializeFilters();  // Initialize filter UI after products load
      break;
    case 3:
      await initializePrintAreas();
      break;
    case 4:
      // Logic for design generation
      break;
    case 5:
      await initializePricingStep();
      break;
  }
}

// ------------------------------------------------------------------
//  STEP 5 – PRICING & PUBLISH
// ------------------------------------------------------------------
async function initializePricingStep() {
  const container = document.getElementById('step5-pricing');
  if (!container) return;
  container.style.display = 'block';
  
  // Show loading in the productsContainer, not the entire step5-pricing
  const productsContainer = document.getElementById('productsContainer');
  if (productsContainer) {
    productsContainer.innerHTML = '<div class="text-center"><div class="spinner-border"></div><p>Creating products…</p></div>';
  }

  const token = localStorage.getItem('authToken');
  const storeId = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_store_id')) || null;
  const sellingRegion = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_selling_region')) || 'usa';
  const products = [];

  // Build payload for pricing-orchestrator
  console.log('Building payload. state.productContent:', state.productContent);
  console.log('state.productDesigns:', state.productDesigns);
  
  for (const productId in state.productDesigns) {
    const placements = state.productDesigns[productId];
    const content = state.productContent?.[productId] || {};

    // Use the helper function to get product with variants on demand
    const product = await getProductWithVariants(productId);
    console.log(`Product ${productId}:`, { content, product, placements });
    if (!product) continue;

    for (const placement of placements) {
      const { position } = placement;
      const imageUrl = state.generatedImages?.[`${productId}_${position}`];

      const catalogPlacement = Array.isArray(product.placements)
        ? product.placements.find(p => String(p.placement).toLowerCase() === String(position).toLowerCase())
        : null;

      const placementDpi = catalogPlacement?.dpi || 300;
      // Prefer user-selected print area sizes from Step 3 (exact sizes from Printful v2 available_placements)
      const selectedAreas = window.state?.selectedPrintAreas?.[productId] || [];
      const normalizeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
      const posKey = normalizeKey(position);
      const selectedMatch = Array.isArray(selectedAreas)
        ? selectedAreas.find(a => {
            const aKey = normalizeKey(a.position);
            return aKey === posKey || (aKey.includes('front') && posKey.includes('front'));
          })
        : null;

      const calculatedWidth = catalogPlacement?.print_area_width
        ? Math.round(Number(catalogPlacement.print_area_width) * placementDpi)
        : null;
      const calculatedHeight = catalogPlacement?.print_area_height
        ? Math.round(Number(catalogPlacement.print_area_height) * placementDpi)
        : null;

      // Fallback: if no Step 3 selection, fetch precise sizes from get-print-area-specs
      let overrideWidth = null;
      let overrideHeight = null;
      if (!selectedMatch) {
        try {
          const token = (typeof localStorage !== 'undefined' && localStorage.getItem('authToken')) || '';
          const resp = await fetch('/.netlify/functions/get-print-area-specs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ productId: Number(productId) })
          });
          const json = await resp.json().catch(() => ({}));
          if (resp.ok && json?.printAreas && Array.isArray(json.printAreas)) {
            const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
            const match = json.printAreas.find(pa => {
              const aKey = norm(pa.position);
              return aKey === posKey || (aKey.includes('front') && posKey.includes('front'));
            });
            if (match?.width && match?.height) {
              overrideWidth = match.width;
              overrideHeight = match.height;
              console.log('[PRICING] Using v2 available_placements fallback sizes:', { position, overrideWidth, overrideHeight });
            }
          }
        } catch (e) {
          console.warn('[PRICING] get-print-area-specs fallback failed:', e.message || e);
        }
      }

      const width = overrideWidth || selectedMatch?.width || placement.width || calculatedWidth || 3000;
      const height = overrideHeight || selectedMatch?.height || placement.height || calculatedHeight || 3000;

      const techniqueKey = (selectedMatch?.technique
        || placement.technique
        || catalogPlacement?.technique
        || catalogPlacement?.technique_key
        || (Array.isArray(product.techniques)
          ? (product.techniques.find(t => t.is_default)?.key || product.techniques[0]?.key)
          : null)
        || 'digital').toLowerCase();

      const mockupStyleIds = Array.isArray(catalogPlacement?.mockup_styles)
        ? catalogPlacement.mockup_styles.map(style => style?.id).filter(Boolean)
        : [];
      const defaultStyleId = mockupStyleIds[0] || null;

      // Find the first available variant for this product
      const variant = Array.isArray(product.variants) && product.variants.length > 0 ? product.variants[0] : null;

      const productPayload = {
        catalog_product_id : Number(productId),
        catalog_variant_id : variant ? variant.id : null,
        title            : content.title || `${product.title} – ${position}`,
        description      : content.description || '',
        tags             : content.tags || [],
        keyFeatures      : content.key_features || [],
        materials        : content.materials || [],
        placement,
        imageUrl,
        width,
        height,
        technique        : techniqueKey,
        style_id         : defaultStyleId,
        mockup_style_ids : mockupStyleIds,
        placement_display : catalogPlacement?.display_name || position,
        dpi              : placementDpi
      };

      console.log('Product payload being added:', productPayload);
      products.push(productPayload);
    }
  }

  console.log('Final payload being sent to pricing-orchestrator:', { products, sellingRegion });
  
  try {
    const orchestratorPayload = {
      products,
      selling_region: sellingRegion,
      ...(storeId ? { store_id: storeId } : {})
    };

    const response = await fetch('/.netlify/functions/pricing-orchestrator', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body   : JSON.stringify(orchestratorPayload)
    });
    
    console.log('Pricing orchestrator response status:', response.status);
    const responseText = await response.text();
    console.log('Pricing orchestrator response text:', responseText);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${responseText}`);
    }
    
    let res;
    try {
      res = JSON.parse(responseText);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      throw new Error(`Invalid JSON response: ${responseText.slice(0, 200)}`);
    }
    
    if (!res.success) throw new Error(res.error);
    renderPricingUI(res.products);
  } catch (err) {
    console.error('Pricing orchestrator error:', err);
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

// Global tracking for pending mockups
window.pendingMockups = [];

function renderPricingUI(products) {
  console.log('[PRICING] renderPricingUI called with products:', products.length);
  const box = document.getElementById('productsContainer');
  if (!box) {
    console.error('[PRICING] productsContainer not found!');
    return;
  }
  console.log('[PRICING] Found productsContainer, clearing it');
  box.innerHTML = '';
  
  // Track products with pending mockups for polling
  window.pendingMockups = [];
  console.log('[PRICING] Initialized window.pendingMockups');
  
  products.forEach(p => {
    const mockupSource = Array.isArray(p.mockups)
      ? (typeof p.mockups[0] === 'string' ? p.mockups[0] : p.mockups[0]?.url)
      : '';

    const placementId = p.placement?.position || p.placement?.id || p.placement;
    const variantPricing = Array.isArray(p.pricing?.variants)
      ? p.pricing.variants.find(v => String(v.id) === String(p.catalog_variant_id))
      : null;
    const techniquePricing = variantPricing?.techniques?.[0];
    const variantPrice = techniquePricing ? parseFloat(techniquePricing.price || 0) : 0;
    const placementPricing = Array.isArray(p.pricing?.product?.placements)
      ? p.pricing.product.placements.find(pl => String(pl.id) === String(placementId))
      : null;
    const placementPrice = placementPricing ? parseFloat(placementPricing.price || placementPricing.discounted_price || 0) : 0;
    const totalCost = (variantPrice + placementPrice).toFixed(2);

    // Check if mockup is pending
    console.log(`[PRICING] Product ${p.product_id}: mockup_pending=${p.mockup_pending}, mockup_task_id=${p.mockup_task_id}`);
    if (p.mockup_pending) {
      console.log(`[PRICING] Product ${p.product_id} has pending mockup`);
      if (p.mockup_task_id) {
        // We have a task ID, poll for it
        console.log(`[PRICING] Adding to pending list: taskId=${p.mockup_task_id}`);
        window.pendingMockups.push({ product: p, taskId: p.mockup_task_id, productId: p.product_id });
      } else if (p.rate_limited) {
        // Rate limited - retry the orchestrator call after delay
        console.log(`[PRICING] Product ${p.product_id} rate limited, will retry orchestrator call`);
        window.pendingMockups.push({ product: p, taskId: null, productId: p.product_id, retryPayload: p.retry_payload, isRetry: true });
      }
    } else {
      console.log(`[PRICING] Product ${p.product_id} mockup is not pending`);
    }
    
    if (p.mockup_pending) {
      // Store product data as base64 for publishing (Unicode-safe)
      const productDataJson = btoa(unescape(encodeURIComponent(JSON.stringify(p))));
      box.insertAdjacentHTML('beforeend', `
        <div class="card mb-3" data-product-id="${p.product_id}" data-catalog-product-id="${p.catalog_product_id}" data-base-cost="${totalCost}" data-product-b64="${productDataJson}">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span>${p.title}</span>
            <span class="badge bg-secondary">${placementPricing?.title || (placementId ? placementId.toUpperCase() : '')}</span>
          </div>
          <div class="card-body d-flex align-items-center gap-3" style="flex-wrap: wrap;">
            <div class="spinner-border spinner-border-sm text-primary" role="status">
              <span class="visually-hidden">Generating mockup...</span>
            </div>
            <div class="flex-grow-1">
              <p class="mb-1"><strong>Base cost:</strong> <span class="base-cost-amount">$${totalCost}</span></p>
              <p class="text-muted small">Generating mockup...</p>
              <div class="d-flex align-items-center gap-2">
                <label class="form-label mb-0" style="min-width:120px">Markup %</label>
                <input type="number" class="form-control markup" value="40" min="1" max="500" style="width:90px" disabled>
                <span class="sale-price badge bg-success fs-6">$${(totalCost * 1.4).toFixed(2)}</span>
              </div>
            </div>
            <div class="d-flex gap-2" style="flex-shrink: 0;">
              <button class="btn btn-sm btn-success publish-btn" data-id="${p.catalog_product_id}" data-db-id="${p.product_id}" disabled>
                <i class="bi bi-cloud-arrow-up"></i> Publish
              </button>
              <button class="btn btn-sm btn-info etsy-btn" data-id="${p.catalog_product_id}" data-db-id="${p.product_id}" title="Send to Etsy">
                <i class="bi bi-shop"></i> Etsy
              </button>
            </div>
          </div>
        </div>
      `);
    } else {
      // Store product data as base64 for publishing (Unicode-safe)
      const productDataJson = btoa(unescape(encodeURIComponent(JSON.stringify(p))));
      box.insertAdjacentHTML('beforeend', `
        <div class="card mb-3" data-product-id="${p.product_id}" data-catalog-product-id="${p.catalog_product_id}" data-base-cost="${totalCost}" data-product-b64="${productDataJson}">
          <div class="card-header d-flex justify-content-between align-items-center">
            <span>${p.title}</span>
            <span class="badge bg-secondary">${placementPricing?.title || (placementId ? placementId.toUpperCase() : '')}</span>
          </div>
          <div class="card-body d-flex align-items-center gap-3" style="flex-wrap: wrap;">
            ${mockupSource ? `<img src="${mockupSource}" width="140" class="rounded shadow-sm">` : ''}
            <div class="flex-grow-1">
              <p class="mb-1"><strong>Base cost:</strong> <span class="base-cost-amount">$${totalCost}</span></p>
              <div class="d-flex align-items-center gap-2">
                <label class="form-label mb-0" style="min-width:120px">Markup %</label>
                <input type="number" class="form-control markup" value="40" min="1" max="500" style="width:90px">
                <span class="sale-price badge bg-success fs-6">$${(totalCost * 1.4).toFixed(2)}</span>
              </div>
            </div>
            <div class="d-flex gap-2" style="flex-shrink: 0;">
              <button class="btn btn-sm btn-success publish-btn" data-id="${p.catalog_product_id}" data-db-id="${p.product_id}">
                <i class="bi bi-cloud-arrow-up"></i> Publish
              </button>
              <button class="btn btn-sm btn-info etsy-btn" data-id="${p.catalog_product_id}" data-db-id="${p.product_id}" title="Send to Etsy">
                <i class="bi bi-shop"></i> Etsy
              </button>
            </div>
          </div>
        </div>
      `);
    }
  });

  // Enable the publish button now that we have products
  const publishBtn = document.getElementById('publishSelectedBtn');
  if (publishBtn && products.length > 0) {
    publishBtn.disabled = false;
  }

  // Attach Etsy button click handlers (works for both pending and ready cards)
  box.querySelectorAll('.etsy-btn').forEach(etsyBtn => {
    etsyBtn.disabled = false;
    if (!etsyBtn.__etsyBound) {
      etsyBtn.__etsyBound = true;
      etsyBtn.addEventListener('click', () => {
        const card = etsyBtn.closest('.card');
        try { sendToEtsy(card); } catch (e) { console.error('[ETSY] Click handler error', e); }
      });
    }
  });

  // Add shipping estimates to each product card (if helper is available)
  try {
    const getAuth = () => (
      localStorage.getItem('authToken') ||
      localStorage.getItem('auth_token') ||
      localStorage.getItem('token') ||
      localStorage.getItem('supabase.auth.token') ||
      sessionStorage.getItem('authToken') ||
      sessionStorage.getItem('auth_token') ||
      sessionStorage.getItem('token') ||
      (window && window.authToken)
    );
    const authToken = getAuth();
    console.log('[SHIPPING] Wiring: helper fn present =', typeof addShippingEstimateToCard === 'function', 'authToken present =', !!authToken);
    if (typeof addShippingEstimateToCard === 'function' && authToken) {
      const cards = box.querySelectorAll('.card[data-product-b64]');
      console.log('[SHIPPING] Found cards needing estimate:', cards.length);
      cards.forEach((card, idx) => {
        const b64 = card.getAttribute('data-product-b64');
        if (!b64) return;
        let productData = null;
        try { productData = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch {}
        if (!productData) return;
        console.log('[SHIPPING] Calling helper for card', idx, {
          product_id: productData.product_id,
          catalog_variant_id: productData.catalog_variant_id
        });
        // Fire-and-forget; the helper updates the card when ready
        addShippingEstimateToCard(card, productData, authToken).catch(err => {
          console.warn('[SHIPPING] Failed to add estimate for card', err?.message || err);
        });
      });
    }
  } catch (e) {
    console.warn('[SHIPPING] Error wiring estimates:', e?.message || e);
  }

  // If OAuth just completed, resume the pending send automatically
  if (localStorage.getItem('etsy_resume_pending') === '1') {
    const resumeId = localStorage.getItem('etsy_resume_db_id');
    if (resumeId) {
      const card = document.querySelector(`[data-product-id="${resumeId}"]`) || document.querySelector(`.etsy-btn[data-db-id="${resumeId}"]`)?.closest('.card');
      if (card) {
        try { sendToEtsy(card); } catch (e) { console.error('[ETSY] Resume after render failed', e); }
      }
    }
    localStorage.removeItem('etsy_resume_pending');
    // don't clear resume_db_id yet in case we need manual retry
  }

  // Update sale price preview when markup changes
  box.querySelectorAll('.markup').forEach(input => {
    input.addEventListener('input', (event) => {
      const card = event.target.closest('.card');
      if (!card) return;
      const baseCostAttr = card.getAttribute('data-base-cost');
      let baseCost = baseCostAttr ? parseFloat(baseCostAttr) : NaN;
      if (!isFinite(baseCost)) {
        const baseCostEl = card.querySelector('.base-cost-amount');
        const raw = baseCostEl ? baseCostEl.textContent : '';
        baseCost = parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0;
      }
      const markup = Math.max(1, Math.min(500, Number(event.target.value) || 0));
      const salePrice = (baseCost * (1 + markup / 100)).toFixed(2);
      const badge = card.querySelector('.sale-price');
      if (badge) badge.textContent = `$${salePrice}`;
    });
  });
  
  // Poll for pending mockups
  if (window.pendingMockups.length > 0) {
    console.log(`[PRICING] Polling for ${window.pendingMockups.length} pending mockups`, window.pendingMockups);
    console.log(`[PRICING] About to call pollForPendingMockups`);
    pollForPendingMockups(window.pendingMockups);
  } else {
    console.log(`[PRICING] No pending mockups to poll`);
  }
}

/**
 * Poll for pending mockup completion
 */
async function pollForPendingMockups(pendingMockups) {
  const token = localStorage.getItem('authToken');
  const maxAttempts = 120; // 2 minutes max (120 * 1 second)
  let attempts = 0;
  
  console.log(`[MOCKUP-POLL] Starting poll for ${pendingMockups.length} tasks:`, pendingMockups.map(p => p.taskId));
  
  const pollInterval = setInterval(async () => {
    // Poll every 1 second
    attempts++;
    
    if (attempts > maxAttempts) {
      clearInterval(pollInterval);
      console.error('[MOCKUP-POLL] Timeout waiting for mockups after 2 minutes');
      return;
    }
    
    // Only log every 10 attempts to reduce noise
    if (attempts % 10 === 0) {
      console.log(`[MOCKUP-POLL] Attempt ${attempts}/${maxAttempts}, checking ${pendingMockups.length} tasks`);
    }
    
    for (let i = pendingMockups.length - 1; i >= 0; i--) {
      const pending = pendingMockups[i];
      try {
        // If we don't have a task ID, skip this one (orchestrator already created it or will on next cycle)
        if (!pending.taskId) {
          console.log(`[MOCKUP-POLL] No task ID for product ${pending.productId}, skipping`);
          continue;
        }
        
        console.log(`[MOCKUP-POLL] Checking task ${pending.taskId}...`);
        const response = await fetch('/.netlify/functions/printful-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            endpoint: `/v2/mockup-tasks?id=${pending.taskId}`,
            method: 'GET'
          })
        });
        
        const result = await response.json();
        console.log(`[MOCKUP-POLL] Task ${pending.taskId} response:`, result);
        
        const task = result?.data?.data?.[0];
        const status = task?.status?.toLowerCase();
        
        console.log(`[MOCKUP-POLL] Task ${pending.taskId} status: ${status}`);
        
        if (status === 'completed') {
          console.log(`[MOCKUP-POLL] Task ${pending.taskId} COMPLETED!`);
          console.log(`[MOCKUP-POLL] Task data:`, task);
          
          // Extract mockup URLs
          const mockupUrls = [];
          (task?.catalog_variant_mockups || []).forEach(variantMockup => {
            (variantMockup?.mockups || []).forEach(mockup => {
              if (mockup.mockup_url) {
                console.log(`[MOCKUP-POLL] Found mockup: placement=${mockup.placement}, style_id=${mockup.style_id}, url=${mockup.mockup_url.substring(0, 50)}...`);
                mockupUrls.push(mockup.mockup_url);
              }
            });
          });
          
          console.log(`[MOCKUP-POLL] Found ${mockupUrls.length} mockup URLs (total)`);
          
          // Update the card with mockup
          const card = document.querySelector(`[data-product-id="${pending.productId}"]`);
          console.log(`[MOCKUP-POLL] Looking for card with selector [data-product-id="${pending.productId}"]`);
          console.log(`[MOCKUP-POLL] Card found:`, card);
          
          if (card) {
            console.log(`[MOCKUP-POLL] Card HTML before update:`, card.innerHTML);
            
            const bodyDiv = card.querySelector('.card-body');
            console.log(`[MOCKUP-POLL] Body div:`, bodyDiv);
            
            if (bodyDiv) {
              // Remove spinner and loading text
              const spinner = bodyDiv.querySelector('.spinner-border');
              if (spinner) {
                console.log(`[MOCKUP-POLL] Removing spinner`);
                spinner.remove();
              }
              const loadingText = bodyDiv.querySelector('.text-muted');
              if (loadingText) {
                console.log(`[MOCKUP-POLL] Removing loading text`);
                loadingText.remove();
              }
              
              // Remove any existing mockup containers (from previous polling)
              const existingMockupContainers = bodyDiv.querySelectorAll('.mockup-container');
              existingMockupContainers.forEach(container => {
                console.log(`[MOCKUP-POLL] Removing existing mockup container`);
                container.remove();
              });
              
              // Add mockup images if available
              if (mockupUrls.length > 0) {
                // Create a container for mockup images
                const mockupContainer = document.createElement('div');
                mockupContainer.className = 'd-flex gap-2 flex-wrap mockup-container';
                mockupContainer.style.marginRight = '10px';
                
                mockupUrls.forEach((url, idx) => {
                  const img = document.createElement('img');
                  img.src = url;
                  img.width = 140;
                  img.className = 'rounded shadow-sm';
                  img.title = `Mockup ${idx + 1}`;
                  mockupContainer.appendChild(img);
                  console.log(`[MOCKUP-POLL] Adding mockup ${idx + 1}`);
                });
                
                bodyDiv.insertAdjacentElement('afterbegin', mockupContainer);
              }
            }
            
            // Enable buttons
            const publishBtn = card.querySelector('.publish-btn');
            if (publishBtn) {
              console.log(`[MOCKUP-POLL] Enabling publish button`);
              publishBtn.disabled = false;
              // Ensure clicking the per-card button triggers publish flow
              publishBtn.onclick = () => {
                try { publishSelectedProducts(); } catch (e) { console.error('Publish click failed', e); }
              };
            }

            const etsyBtn = card.querySelector('.etsy-btn');
            if (etsyBtn) {
              console.log(`[MOCKUP-POLL] Enabling Etsy button`);
              etsyBtn.disabled = false;
              // Etsy button click handler
              etsyBtn.onclick = () => {
                try { sendToEtsy(card); } catch (e) { console.error('Etsy click failed', e); }
              };
            }

            const markupInput = card.querySelector('.markup');
            if (markupInput) {
              console.log(`[MOCKUP-POLL] Enabling markup input`);
              markupInput.disabled = false;
            }
            
            console.log(`[MOCKUP-POLL] Updated card for product ${pending.productId}`);
            console.log(`[MOCKUP-POLL] Card HTML after update:`, card.innerHTML);
          } else {
            console.error(`[MOCKUP-POLL] Card not found for product ${pending.productId}`);
          }
          
          // Remove from pending list
          console.log(`[MOCKUP-POLL] Removing task from pending list at index ${i}`);
          pendingMockups.splice(i, 1);
        }
      } catch (err) {
        console.error(`[MOCKUP-POLL] Error polling task ${pending.taskId}:`, err.message);
      }
    }
    
    // Stop polling if no more pending
    if (pendingMockups.length === 0) {
      clearInterval(pollInterval);
      console.log('[MOCKUP-POLL] All mockups completed!');
    }
  }, 1000); // Poll every 1 second
}

/**
 * Initialize print areas step (Step 3)
 * Updated to use proper Printful v1/v2 API endpoints
 */
async function initializePrintAreas() {
  console.log('Initializing Step 3: Print Areas...');
  const container = document.getElementById('step3-content') || document.getElementById('step3-container');
  if (!container) {
    console.error('Step 3 content container not found!');
    return;
  }

  const selectedProductIds = Array.from(state.selectedProducts);
  if (selectedProductIds.length === 0) {
    container.innerHTML = '<div class="alert alert-warning">No products selected. Please go back to Step 2.</div>';
    return;
  }

  container.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div><p>Loading print areas...</p></div>';

  console.log('[PRINT-AREAS] Selected products for print area loading:', selectedProductIds);

  let allProductsHTML = '';
  for (const productId of selectedProductIds) {
    const product = allProducts.find(p => String(p.id) === productId);
    if (!product) continue;

    try {
      console.log(`Fetching print areas for product: ${product.title} (ID: ${productId})`);
      const printAreas = await fetchPrintAreasForProduct(productId);
      console.log(`Print areas result for ${productId}:`, printAreas);

      const productHTML = renderProductPrintAreas(product, printAreas);
      allProductsHTML += productHTML;
    } catch (error) {
      console.error(`Failed to load print areas for product ${productId} (${product.title}):`, error);
      allProductsHTML += `
        <div class="card mb-3">
          <div class="card-header bg-danger text-white">${product.title}</div>
          <div class="card-body">
            <p class="text-danger">Error loading print areas: ${error.message}</p>
            <small class="text-muted">Product ID: ${productId}</small>
          </div>
        </div>`;
    }
  }

  container.innerHTML = allProductsHTML;

  const footerHTML = `
    <div class="card-footer text-end mt-3">
      <button class="btn btn-primary" onclick="proceedToStep4()">Continue to Generation <i class="bi bi-arrow-right"></i></button>
    </div>`;
  container.insertAdjacentHTML('beforeend', footerHTML);
}

/**
 * Fetches print areas for a product using proper Printful v1 API
 * Updated to follow official API documentation
 */
async function fetchPrintAreasForProduct(productId) {
  console.log(`[PRINT-AREAS] Fetching print areas for product ${productId}`);
  if (!productId) throw new Error('Product ID is required');

  const numericProductId = parseInt(productId, 10);
  if (isNaN(numericProductId)) throw new Error(`Invalid product ID format: ${productId}`);

  try {
    // Fetch detailed catalog data (techniques, placements)
    const catalogProduct = await getProductWithVariants(productId);
    const catalogPlacements = Array.isArray(catalogProduct?.placements) ? catalogProduct.placements : [];

    // Prefer exact print areas from our Netlify helper (Printful v2 available_placements)
    try {
      const token = (typeof localStorage !== 'undefined' && localStorage.getItem('authToken')) || '';
      const resp = await fetch('/.netlify/functions/get-print-area-specs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ productId: numericProductId })
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json?.printAreas && Array.isArray(json.printAreas) && json.printAreas.length > 0) {
        const defaultTechnique = (Array.isArray(catalogProduct?.techniques)
          ? (catalogProduct.techniques.find(t => t.is_default)?.key || catalogProduct.techniques[0]?.key)
          : 'digital') || 'digital';
        const mapped = json.printAreas.map(pa => ({
          position : pa.position,
          title    : (pa.position || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || pa.position,
          width    : pa.width,
          height   : pa.height,
          dpi      : 300,
          technique: String(defaultTechnique).toLowerCase()
        }));
        console.log(`[PRINT-AREAS] Using available_placements from get-print-area-specs for ${productId}:`, mapped);
        return mapped;
      }
    } catch (e) {
      console.warn(`[PRINT-AREAS] get-print-area-specs failed for product ${productId}:`, e.message || e);
    }

    if (catalogPlacements.length > 0) {
      console.log(`[PRINT-AREAS] Using catalog placements for ${productId}:`, catalogPlacements);
      const sellingRegion = catalogProduct?.selling_region_name || 'usa';

      const printAreas = catalogPlacements.map((placement, idx) => {
        const dpi = placement.dpi || 300;
        const widthPx = placement.print_area_width ? Math.round(Number(placement.print_area_width) * dpi) : 3000;
        const heightPx = placement.print_area_height ? Math.round(Number(placement.print_area_height) * dpi) : 3000;
        const technique = placement.technique || placement.technique_key ||
          (Array.isArray(catalogProduct?.techniques)
            ? (catalogProduct.techniques.find(t => t.is_default)?.key || catalogProduct.techniques[0]?.key)
            : 'digital');

        return {
          position        : placement.placement || placement.id || `placement_${idx}`,
          title           : placement.display_name || placement.view_name || placement.placement || `Placement ${idx + 1}`,
          width           : widthPx,
          height          : heightPx,
          dpi,
          technique       : (technique || 'digital').toLowerCase(),
          additional_price: placement.additional_price || '0.00',
          mockup_styles   : Array.isArray(placement.mockup_styles) ? placement.mockup_styles : [],
          placement_region: sellingRegion
        };
      });

      console.log(`[PRINT-AREAS] Extracted ${printAreas.length} catalog print areas for ${productId}`);
      return printAreas;
    }

    // Fallback to v1 /products/{id} if catalog placements are missing
    console.warn(`[PRINT-AREAS] Catalog placements missing for product ${productId}, falling back to v1 /products/${numericProductId}`);
    const productRes = await makeApiCall(`/products/${numericProductId}`);
    const product = productRes?.result?.product;

    if (!product) throw new Error(`Unexpected API response structure for product ${productId}`);

    const printAreas = [];
    if (Array.isArray(product.files)) {
      product.files.forEach((file, idx) => {
        if (file.type === 'mockup' || file.id === 'preview') return;

        printAreas.push({
          position        : file.type || file.id || `position_${idx}`,
          width           : 3000,
          height          : 3000,
          dpi             : 300,
          type            : file.type || file.id,
          title           : file.title || file.type || file.id,
          technique       : determineTechniqueFromFile(file, product),
          additional_price: file.additional_price || '0.00'
        });
      });
    }

    console.log(`[PRINT-AREAS] Extracted ${printAreas.length} v1 fallback print areas for ${productId}`, printAreas);
    return printAreas;
  } catch (error) {
    console.error(`[PRINT-AREAS] Error fetching print areas for product ${productId}:`, error);
    throw error;
  }
}

/**
 * Helper function to determine technique from file and product data
 */
function determineTechniqueFromFile(file, product) {
  // Check if file type suggests embroidery
  if (file.type && file.type.toLowerCase().includes('embroidery')) {
    return 'embroidery';
  }
  
  // Use product's default technique
  if (product.techniques && Array.isArray(product.techniques)) {
    const defaultTechnique = product.techniques.find(t => t.is_default);
    if (defaultTechnique) {
      return defaultTechnique.key.toLowerCase();
    }
    // Fallback to first technique
    if (product.techniques.length > 0) {
      return product.techniques[0].key.toLowerCase();
    }
  }
  
  // Default fallback
  return 'dtg';
}

/**
 * Fetches with automatic retry on rate limits (429 errors).
 * 
 * Problem: When Printful/fal.ai rate limits are hit, the entire batch fails.
 * Solution: Automatically retry with exponential backoff.
 * 
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options (method, headers, body, etc.)
 * @param {number} maxRetries - Maximum number of retries (default from config)
 * @returns {Promise<Response>} The fetch response
 * @throws {Error} If all retries fail
 */
async function fetchWithRetry(url, options = {}, maxRetries = RATE_LIMIT_CONFIG.maxRetries) {
  let lastError;
  let lastResponse;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      lastResponse = response;
      
      // If rate limited (429), wait and retry
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader) : null;
        
        // Calculate wait time: use retry-after header if available, otherwise exponential backoff
        let waitMs;
        if (retryAfterSeconds) {
          waitMs = retryAfterSeconds * 1000;
          console.warn(`[RATE-LIMIT] Server requested retry after ${retryAfterSeconds}s`);
        } else {
          waitMs = Math.min(
            RATE_LIMIT_CONFIG.initialDelayMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
            RATE_LIMIT_CONFIG.maxDelayMs
          );
          console.warn(`[RATE-LIMIT] Attempt ${attempt}/${maxRetries} hit 429. Waiting ${waitMs}ms before retry...`);
        }
        
        // Update UI to show rate limiting
        updateRateLimitIndicator(`Rate limited. Retrying in ${Math.ceil(waitMs / 1000)}s...`);
        
        // Wait before retrying
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      
      // If other error, throw it
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 100)}`);
      }
      
      // Success - clear rate limit indicator
      clearRateLimitIndicator();
      return response;
      
    } catch (err) {
      lastError = err;
      
      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        console.error(`[RETRY] All ${maxRetries} attempts failed:`, err);
        throw err;
      }
      
      // Otherwise, wait and retry
      const waitMs = Math.min(
        RATE_LIMIT_CONFIG.initialDelayMs * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt),
        RATE_LIMIT_CONFIG.maxDelayMs
      );
      console.warn(`[RETRY] Attempt ${attempt}/${maxRetries} failed. Waiting ${waitMs}ms before retry...`, err.message);
      
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  
  // Should not reach here, but just in case
  throw lastError || new Error('All retries failed');
}

/**
 * Updates the rate limit indicator in the UI.
 * @param {string} message - The message to display
 */
function updateRateLimitIndicator(message) {
  const indicator = document.getElementById('rateLimitIndicator');
  if (indicator) {
    indicator.textContent = message;
    indicator.classList.remove('d-none');
    indicator.classList.add('rate-limit-warning');
  }
}

/**
 * Clears the rate limit indicator from the UI.
 */
function clearRateLimitIndicator() {
  const indicator = document.getElementById('rateLimitIndicator');
  if (indicator) {
    indicator.classList.add('d-none');
    indicator.classList.remove('rate-limit-warning');
    indicator.textContent = '';
  }
}

/**
 * Calculates optimal image generation size.
 * 
 * Problem: Print areas are calculated at 300 DPI (e.g., 3000x3000px for a 10"x10" area).
 * Sending these to fal.ai causes timeouts (18.5 megapixels is too large).
 * 
 * Solution: Generate at reasonable size (1024-2048px), then upscale for print if needed.
 * 
 * @param {number} printAreaWidthPx - Print area width in pixels (at print DPI)
 * @param {number} printAreaHeightPx - Print area height in pixels (at print DPI)
 * @param {number} maxGenerationDimension - Max dimension for generation (default 2048)
 * @returns {Object} { generationSize: {width, height}, printSize: {width, height} }
 */
function calculateOptimalImageSize(printAreaWidthPx, printAreaHeightPx, maxGenerationDimension = 2048) {
  // Calculate aspect ratio
  const aspectRatio = printAreaWidthPx / printAreaHeightPx;
  
  let generationWidth, generationHeight;
  
  if (aspectRatio > 1) {
    // Landscape: width is larger
    generationWidth = maxGenerationDimension;
    generationHeight = Math.round(maxGenerationDimension / aspectRatio);
  } else if (aspectRatio < 1) {
    // Portrait: height is larger
    generationHeight = maxGenerationDimension;
    generationWidth = Math.round(maxGenerationDimension * aspectRatio);
  } else {
    // Square
    generationWidth = maxGenerationDimension;
    generationHeight = maxGenerationDimension;
  }
  
  // Ensure minimum size
  generationWidth = Math.max(512, generationWidth);
  generationHeight = Math.max(512, generationHeight);
  
  console.log(`[IMAGE-SIZE] Print area: ${printAreaWidthPx}x${printAreaHeightPx}px → Generation: ${generationWidth}x${generationHeight}px`);
  
  return {
    generationSize: {
      width: generationWidth,
      height: generationHeight
    },
    printSize: {
      width: printAreaWidthPx,
      height: printAreaHeightPx
    },
    scaleFactor: printAreaWidthPx / generationWidth
  };
}

/**
 * Renders the HTML for a single product's print areas.
 * @param {object} product - The product object.
 * @param {Array} printAreas - An array of print area objects for the product.
 * @returns {string} The generated HTML string.
 */
function renderProductPrintAreas(product, printAreas) {
  if (!printAreas || printAreas.length === 0) {
    return `
      <div class="card mb-3">
        <div class="card-header">${product.title}</div>
        <div class="card-body">
          <p class="text-muted">No print areas found for this product.</p>
        </div>
      </div>`;
  }

  const printAreasHTML = printAreas.map((area, index) => {
    const areaId = `area_${product.id}_${index}`;
    const technique = area.technique || 'digital';
    const techniqueColor = getTechniqueColor(technique);

    return `
      <div class="form-check print-area-option">
        <input class="form-check-input" type="checkbox" id="${areaId}"
               data-product-id="${product.id}"
               data-position="${area.position}"
               data-width="${area.width}"
               data-height="${area.height}"
               data-technique="${technique}">
        <label class="form-check-label" for="${areaId}">
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <strong>${area.title || area.position}</strong>
              <span class="text-muted small d-block">${area.width}x${area.height}px @ ${area.dpi || 300}dpi</span>
              ${area.additional_price && area.additional_price !== '0.00' ? `<span class="text-warning small">+$${area.additional_price}</span>` : ''}
            </div>
            <div class="d-flex align-items-center" style="gap:8px;">
              <span class="badge" style="background-color: ${techniqueColor}; color: white; font-size: 11px;">
                ${technique.toUpperCase()}
              </span>
              <button type="button" class="btn btn-sm btn-outline-primary"
                      onclick="togglePrintAreaSelection('${product.id}', '${areaId}')">Select</button>
              <button type="button" class="btn btn-sm btn-outline-secondary"
                      onclick="selectOnlyPrintArea('${product.id}', '${areaId}')">Only</button>
            </div>
          </div>
        </label>
      </div>`;
  }).join('');

  return `
    <div class="card mb-3">
      <div class="card-header d-flex justify-content-between align-items-center">
        <span>${product.title}</span>
        <small class="text-muted">${printAreas.length} placement${printAreas.length !== 1 ? 's' : ''} available</small>
      </div>
      <div class="card-body">
        <h6>Available Print Areas</h6>
        <div class="print-areas-list">
          ${printAreasHTML}
        </div>
      </div>
    </div>`;
}

/**
 * Toggle selection for a specific print area checkbox
 */
function togglePrintAreaSelection(productId, areaId) {
  try {
    const el = document.getElementById(areaId);
    if (!el) return;
    el.click();
  } catch (e) { console.warn('togglePrintAreaSelection failed', e); }
}

/**
 * Select only this print area for the given product (unchecks siblings)
 */
function selectOnlyPrintArea(productId, areaId) {
  try {
    // Uncheck all checkboxes for this product
    document.querySelectorAll(`#step3-container .form-check-input[data-product-id='${productId}']`).forEach(cb => {
      cb.checked = false;
    });
    // Check the requested one
    const el = document.getElementById(areaId);
    if (el) el.checked = true;
  } catch (e) { console.warn('selectOnlyPrintArea failed', e); }
}

// ============================================================================
// 3. STEP-BY-STEP WORKFLOW FUNCTIONS
// ============================================================================

/**
 * Moves from Product Selection (Step 2) to Design Configuration (Step 3).
 */
function proceedToStep3() {
  if (state.selectedProducts.size === 0) {
    alert('Please select at least one product to continue.');
    return;
  }
  state.completedSteps.add(2);
  navigateToStep(3);
  console.log('Proceeding to Step 3 with', state.selectedProducts.size, 'products.');
}

/**
 * Moves from Print Area assignment (Step 3) to Design Generation (Step 4).
 */
function proceedToStep4() {
  // Capture the selected print areas for each product, including their dimensions and technique
  const selectedPlacements = {};
  document.querySelectorAll('#step3-container .form-check-input:checked').forEach(input => {
    const productId = input.dataset.productId;
    const position = input.dataset.position;
    const width = parseInt(input.dataset.width, 10);
    const height = parseInt(input.dataset.height, 10);
    const technique = input.dataset.technique || 'digital';

    if (!selectedPlacements[productId]) {
      selectedPlacements[productId] = [];
    }
    selectedPlacements[productId].push({ position, width, height, technique });
  });

  // Validate that every selected product has at least one print area chosen
  const missingSelections = Array.from(state.selectedProducts).filter(id => !selectedPlacements[id] || selectedPlacements[id].length === 0);

  if (missingSelections.length > 0) {
    const productTitles = missingSelections.map(id => {
        const product = allProducts.find(p => String(p.id) === id);
        return product ? `  - ${product.title}` : `  - Product ID ${id}`;
    }).join('\n');
    alert(`Please select at least one print area for the following products:\n${productTitles}`);
    return;
  }

  // Save the selections to the global state
  state.productDesigns = selectedPlacements;
  state.completedSteps.add(3);
  saveState();

  navigateToStep(4);
  console.log('Proceeding to Step 4 with selections:', state.productDesigns);
}

/**
 * Triggers the design generation process in Step 4.
 */
async function generateDesigns() {
  const generateBtn = document.getElementById('generateBtn');
  const prompt = document.getElementById('bulkPrompt').value.trim();
  const style = document.getElementById('bulkStyle').value;
  const colors = document.getElementById('bulkColors').value;
  const audience = document.getElementById('bulkAudience').value;

  if (!prompt) {
    alert('Please enter a design prompt.');
    return;
  }

  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Generating...';

  const token = localStorage.getItem('authToken');
  const jobs = [];

  for (const productId in state.productDesigns) {
    const placements = state.productDesigns[productId];
    const product = allProducts.find(p => String(p.id) === String(productId));
    if (!product) continue;

    for (const placement of placements) {
      const jobId = `job_${productId}_${placement.position}`;
      jobs.push({ jobId, productId, product, placement, status: 'pending' });
    }
  }

  const assignmentTableBody = document.getElementById('assignmentTableBody');
  assignmentTableBody.innerHTML = '';

  jobs.forEach(job => {
    const row = document.createElement('tr');
    row.id = job.jobId;
    row.innerHTML = `
      <td>${job.product.title}</td>
      <td>${job.placement.position}</td>
      <td>${job.placement.width}x${job.placement.height}</td>
      <td class="content-title"><span class="spinner-border spinner-border-sm"></span></td>
      <td class="content-tags"><span class="spinner-border spinner-border-sm"></span></td>
      <td class="image-status"><span class="spinner-border spinner-border-sm"></span></td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="cancelJob('${job.jobId}')">Cancel</button></td>
    `;
    assignmentTableBody.appendChild(row);
  });

  document.getElementById('assignmentTableCard').style.display = 'block';

  for (const job of jobs) {
    const row = document.getElementById(job.jobId);
    try {
      // 1. Generate content (synchronous - no polling needed)
      if (!state.productContent || !state.productContent[job.productId]) {
        console.log(`Generating content for product ${job.productId}...`);
        const contentStartTime = Date.now();

        // Use fetchWithRetry to handle rate limits automatically
        const contentResponse = await fetchWithRetry('/.netlify/functions/generate-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt, style, colors, audience,
            contentType: 'product-content',
            productId: job.productId,
            productInfo: [job.product]
          })
        });
        
        const contentRes = await contentResponse.json();

        const contentDuration = Date.now() - contentStartTime;
        console.log(`Content generated in ${contentDuration}ms:`, contentRes);

        if (!contentRes.success) {
          throw new Error(contentRes.error || 'Content generation failed');
        }

        if (!state.productContent) state.productContent = {};
        state.productContent[job.productId] = contentRes;
        saveState();
      } else {
        console.log(`Using cached content for product ${job.productId}`);
      }

      // Display the generated content in the table
      const productContent = state.productContent[job.productId];
      console.log('Product content for display:', productContent);
      if (productContent) {
        const titleElement = row.querySelector('.content-title');
        const tagsElement = row.querySelector('.content-tags');
        console.log('Title element:', titleElement, 'Tags element:', tagsElement);
        
        if (titleElement) {
          titleElement.textContent = (productContent.title || 'No title').substring(0, 50) + (productContent.title && productContent.title.length > 50 ? '...' : '');
        }
        if (tagsElement) {
          tagsElement.textContent = (productContent.tags || []).slice(0, 3).join(', ') || 'No tags';
        }
      }

      // 2. Generate image
      console.log(`Generating image for ${job.productId} ${job.placement.position} (${job.placement.width}x${job.placement.height})...`);
      const imageStartTime = Date.now();

      // Calculate optimal generation size (not print size)
      const imageSizes = calculateOptimalImageSize(job.placement.width, job.placement.height);
      const generationSize = imageSizes.generationSize;
      
      console.log(`[IMAGE-GEN] Using generation size: ${generationSize.width}x${generationSize.height}px (print size: ${imageSizes.printSize.width}x${imageSizes.printSize.height}px)`);

      // Use fetchWithRetry to handle rate limits automatically
      const imageResponse = await fetchWithRetry('/.netlify/functions/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt, style, colors, audience,
          size: `${generationSize.width}x${generationSize.height}`,
          numImages: 1
        })
      });
      
      const imageRes = await imageResponse.json();

      const initialDuration = Date.now() - imageStartTime;
      console.log(`Image API response in ${initialDuration}ms:`, { success: imageRes.success, pending: imageRes.pending, hasImages: !!(imageRes.images?.length) });

      if (!imageRes.success) {
        throw new Error(imageRes.error || 'Image generation failed');
      }

      let imgUrl = null;

      // Handle immediate success (direct image URLs)
      if (imageRes.images && Array.isArray(imageRes.images) && imageRes.images.length > 0) {
        const firstImage = imageRes.images[0];
        imgUrl = typeof firstImage === 'string' ? firstImage : firstImage?.url;
        console.log('Image ready immediately:', imgUrl);
      }
      // Handle pending response (needs polling)
      else if (imageRes.pending && imageRes.request_id) {
        console.log('Image is pending, starting optimized polling...');
        // Pass through the model so the server polls the correct provider path
        imgUrl = await pollForImageResult(imageRes.request_id, token, imageRes.model);
        console.log('Polling result:', imgUrl);
      }
      // Handle unexpected response format
      else {
        console.warn('Unexpected image response format:', imageRes);
      }

      const totalImageDuration = Date.now() - imageStartTime;
      console.log(`Final image result after ${totalImageDuration}ms:`, imgUrl ? 'SUCCESS' : 'FAILED');

      if (imgUrl) {
        const imageElement = row.querySelector('.image-status');
        if (imageElement) {
          imageElement.innerHTML = `<img src="${imgUrl}" width="50" class="rounded" title="Generated in ${totalImageDuration}ms">`;
        }
        if (!state.generatedImages) state.generatedImages = {};
        state.generatedImages[`${job.productId}_${job.placement.position}`] = imgUrl;
        saveState();
        console.log(`✅ Image stored for ${job.productId}_${job.placement.position}`);
      } else {
        const imageElement = row.querySelector('.image-status');
        if (imageElement) {
          imageElement.innerHTML = '<span class="text-danger">Failed</span>';
        }
        console.error(`❌ Image generation failed for ${job.productId}_${job.placement.position}`);
      }
    } catch (err) {
      console.error(err);
      row.querySelector('.image-status').textContent = 'Error';
    }
  }

  generateBtn.disabled = false;
  generateBtn.innerHTML = '<i class="bi bi-magic"></i> Generate Designs';
  document.getElementById('proceedToStep5Btn').style.display = 'block';
}

async function pollForImageResult(requestId, token, model, maxAttempts = 15, delay = 1500) {
  console.log(`Starting optimized polling for request ${requestId}`);

  for (let i = 0; i < maxAttempts; i++) {
    // Shorter initial delay since server already waited
    const currentDelay = i === 0 ? 500 : delay; // First check after 500ms
    await new Promise(resolve => setTimeout(resolve, currentDelay));

    try {
      console.log(`Polling attempt ${i + 1}/${maxAttempts} for ${requestId}`);

      const response = await fetch('/.netlify/functions/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        // Include model so the server hits the correct fal queue endpoints
        body: JSON.stringify({ statusOnly: true, requestId: requestId, model: model || 'seedream' })
      }).then(r => r.json());

      console.log(`Polling response ${i + 1}:`, { success: response.success, pending: response.pending, hasImages: !!(response.images?.length) });

      if (response.success && response.images && response.images.length > 0) {
        const image = response.images[0];
        const url = typeof image === 'string' ? image : image.url;
        console.log(`Image ready after ${i + 1} attempts:`, url);
        return url;
      }

      if (!response.pending) {
        // If it's not pending and not a success, it's a failure.
        console.error('Image generation failed after polling:', response.error);
        return null;
      }

      // Still pending, continue polling
      console.log(`Still pending, continuing to poll (attempt ${i + 1})`);

    } catch (error) {
      console.error(`Polling request ${i + 1} failed:`, error);
      // Don't return null immediately, try a few more times
      if (i >= maxAttempts - 2) {
        return null; // Only fail on last couple attempts
      }
    }
  }

  console.error(`Image generation polling timed out after ${maxAttempts} attempts for ${requestId}`);
  return null; // Timeout
}

/**
 * Moves from Design Generation (Step 4) to Pricing (Step 5).
 */
function proceedToStep5() {
  state.completedSteps.add(3);
  state.completedSteps.add(4);
  navigateToStep(5);
  console.log('Proceeding to Step 5: Pricing & Publishing.');
  // This would kick off product creation in the background.
}

// ============================================================================
// 4. PRICING & PUBLISHING (STEP 5)
// ============================================================================

/**
 * Applies a bulk markup percentage to selected products.
 */
function applyBulkMarkup() {
  alert('applyBulkMarkup() needs to be implemented.');
  console.log('applyBulkMarkup() called.');
}

/**
 * Applies a target margin to selected products.
 */
function applyTargetMargin() {
  alert('applyTargetMargin() needs to be implemented.');
  console.log('applyTargetMargin() called.');
}

/**
 * Publishes the selected products to the store.
 * Iterates through all product cards and creates products in Printful.
 */
async function publishSelectedProducts() {
  const token = localStorage.getItem('authToken');
  const storeId = localStorage.getItem('pf_store_id');
  
  if (!token) {
    alert('❌ Authentication error: No token found. Please log in again.');
    window.location.href = '/auth.html';
    return;
  }

  if (!storeId) {
    alert('❌ Store error: No store selected. Please select a store from the dropdown.');
    return;
  }

  const publishBtn = document.getElementById('publishSelectedBtn');
  const originalText = publishBtn.innerHTML;
  publishBtn.disabled = true;
  publishBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Publishing...';

  try {
    // Get all product cards from the pricing UI
    const productCards = document.querySelectorAll('#productsContainer .card');
    
    if (productCards.length === 0) {
      alert('❌ No products to publish. Please complete Steps 2-4 first.');
      return;
    }

    console.log(`[PUBLISH] Starting to publish ${productCards.length} products...`);
    
    const results = [];
    let successCount = 0;
    let failureCount = 0;

    // Process each product card
    for (let i = 0; i < productCards.length; i++) {
      const card = productCards[i];
      
      try {
        // Extract product data from card
        const titleEl = card.querySelector('.card-header span:first-child');
        const title = titleEl?.textContent?.trim() || `Product ${i + 1}`;
        
        const publishBtnInCard = card.querySelector('.publish-btn');

        // Get stored product data from the card (base64 encoded, Unicode-safe)
        let productData;
        try {
          const productB64 = card.dataset.productB64;
          if (productB64) {
            const productJson = decodeURIComponent(escape(atob(productB64)));
            productData = JSON.parse(productJson);
          } else {
            productData = null;
          }
        } catch (e) {
          console.error('[PUBLISH] Failed to parse product data:', e);
          productData = null;
        }

        if (!productData) {
          throw new Error('No product data found on card');
        }

        const catalogProductId = productData.catalog_product_id;
        const dbProductId = productData.product_id;

        console.log(`[PUBLISH] Card IDs - Catalog: ${catalogProductId}, Database: ${dbProductId}`);
        console.log(`[PUBLISH] Processing product ${i + 1}/${productCards.length}: ${title} (ID: ${catalogProductId})`);

        const markupInput = card.querySelector('.markup');
        const markup = parseFloat(markupInput?.value || 40);

        const mockupImg = card.querySelector('img');
        const mockupUrl = mockupImg?.src;

        const baseCostEl = card.querySelector('.card-body strong');
        const baseCost = parseFloat(baseCostEl?.textContent?.replace(/[^0-9.]/g, '') || 0);

        const retailPrice = (baseCost * (1 + markup / 100)).toFixed(2);

        // Build placement files from stored product data
        const placementFiles = [];
        if (productData.placement) {
          const placement = productData.placement;
          const imageUrl = Array.isArray(productData.mockups) && productData.mockups.length > 0
            ? (typeof productData.mockups[0] === 'string' ? productData.mockups[0] : productData.mockups[0]?.url)
            : mockupUrl;

          placementFiles.push({
            placement: placement.position || placement.id || placement,
            image_url: imageUrl,
            width: placement.width,
            height: placement.height,
            dpi: placement.dpi || 300
          });
        }

        // Build product payload directly from stored data
        const product = {
          title: title,
          description: productData.description || `${title} - Custom Design`,
          catalog_product_id: catalogProductId,
          catalog_variant_id: productData.catalog_variant_id,
          selected_variant_ids: [productData.catalog_variant_id],
          placement_files: placementFiles,
          technique: productData.technique || 'dtg',
          initial_images: productData.mockups || []
        };
        
        if (!product) {
          throw new Error('Failed to build product payload');
        }

        console.log(`[PUBLISH] Payload for ${title}:`, product);

        // Call create-product function
        console.log(`[PUBLISH] Calling printful-create-product for ${title}...`);
        const response = await fetch('/.netlify/functions/printful-create-product', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            ...product,
            store_id: storeId,
            retail_price: retailPrice
          })
        });

        console.log(`[PUBLISH] Response status for ${title}:`, response.status, response.statusText);
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[PUBLISH] HTTP error for ${title}:`, response.status, errorText);
          throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        }

        const result = await response.json();
        console.log(`[PUBLISH] Parsed result for ${title}:`, result);
        
        if (result.success) {
          console.log(`✅ Product ${title} published successfully`);
          results.push({ success: true, productId: catalogProductId, title, message: 'Published' });
          publishBtnInCard.disabled = true;
          publishBtnInCard.innerHTML = '<i class="bi bi-check-circle"></i> Published';
          publishBtnInCard.classList.remove('btn-success');
          publishBtnInCard.classList.add('btn-secondary');
          successCount++;
        } else {
          console.error(`❌ Product ${title} failed:`, result.error);
          results.push({ success: false, productId: catalogProductId, title, error: result.error });
          publishBtnInCard.classList.add('btn-danger');
          failureCount++;
        }
      } catch (err) {
        console.error(`[PUBLISH] Error processing product ${i + 1}:`, err);
        results.push({ success: false, error: err.message });
        failureCount++;
      }

      // Small delay between requests to avoid rate limiting
      if (i < productCards.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Show summary
    console.log(`[PUBLISH] Complete! ${successCount} succeeded, ${failureCount} failed`);
    
    const summary = `
📊 Publishing Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Successful: ${successCount}
❌ Failed: ${failureCount}
📦 Total: ${productCards.length}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${failureCount === 0 ? '🎉 All products published successfully!' : '⚠️ Some products failed. Check the console for details.'}
    `;

    alert(summary);
    
    // If all successful, offer to reset
    if (failureCount === 0) {
      const resetNow = confirm('All products published! Would you like to start a new batch?');
      if (resetNow) {
        resetState();
        navigateToStep(2);
      }
    }

  } catch (err) {
    console.error('[PUBLISH] Critical error:', err);
    alert(`❌ Publishing failed: ${err.message}\n\nCheck the browser console for details.`);
  } finally {
    publishBtn.disabled = false;
    publishBtn.innerHTML = originalText;
  }
}

/**
 * Send a single product to Etsy
 * @param {HTMLElement} card - The product card element
 */
async function sendToEtsy(card) {
  const etsyBtn = card.querySelector('.etsy-btn');
  const originalText = etsyBtn.innerHTML;
  
  try {
    etsyBtn.disabled = true;
    etsyBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Sending...';

    // Get product data from card
    let productData;
    try {
      const productB64 = card.dataset.productB64;
      if (productB64) {
        const productJson = decodeURIComponent(escape(atob(productB64)));
        productData = JSON.parse(productJson);
      } else {
        productData = null;
      }
    } catch (e) {
      console.error('[ETSY] Failed to parse product data:', e);
      productData = null;
    }

    if (!productData) {
      throw new Error('No product data found on card');
    }

    const title = card.querySelector('.card-header span:first-child')?.textContent?.trim() || 'Product';
    const markupInput = card.querySelector('.markup');
    const markup = parseFloat(markupInput?.value || 40);
    const mockupImg = card.querySelector('img');
    const mockupUrl = mockupImg?.src;
    const baseCostEl = card.querySelector('.card-body strong');
    let baseCost = parseFloat((baseCostEl?.textContent || '').replace(/[^0-9.]/g, ''));
    if (!baseCost || isNaN(baseCost)) {
      // fallback: use data attribute seeded at render
      const ds = card.getAttribute('data-base-cost');
      const dsNum = ds ? Number(ds) : 0;
      if (dsNum) baseCost = dsNum;
    }
    if (!baseCost || isNaN(baseCost)) {
      // fallback: compute from productData.pricing
      try {
        const varPrice = Number(productData?.pricing?.variants?.[0]?.techniques?.[0]?.price) || 0;
        const placePrice = Number(productData?.pricing?.product?.placements?.[0]?.price) || 0;
        const discVar = Number(productData?.pricing?.variants?.[0]?.techniques?.[0]?.discounted_price) || 0;
        const discPlace = Number(productData?.pricing?.product?.placements?.[0]?.discounted_price) || 0;
        const bestVar = discVar || varPrice;
        const bestPlace = discPlace || placePrice;
        const calc = bestVar + bestPlace;
        if (calc > 0) baseCost = calc;
      } catch {}
    }
    // final fallback
    if (!baseCost || isNaN(baseCost) || baseCost <= 0) baseCost = 20; // sane default to avoid zero price
    const retailPrice = Number((baseCost * (1 + (isNaN(markup) ? 40 : markup) / 100)).toFixed(2));

    // Get auth token from various possible storage locations
    let token = localStorage.getItem('auth_token') || 
                localStorage.getItem('token') ||
                localStorage.getItem('supabase.auth.token') ||
                sessionStorage.getItem('auth_token') ||
                sessionStorage.getItem('token');

    // If no token found, get it from the page's global state
    if (!token && window.authToken) {
      token = window.authToken;
    }

    console.log('[ETSY] Auth token status:', token ? 'found' : 'not found');

    // Check if user has Etsy OAuth token
    let etsyToken = localStorage.getItem('etsy_access_token');
    let etsyShopId = localStorage.getItem('etsy_shop_id');

    if (!etsyToken) {
      console.log('[ETSY] No Etsy token found.');
      alert('⚠️ Please authorize with Etsy first by clicking the "Connect Etsy" button in the navigation bar.');
      throw new Error('Etsy not authorized. Please connect Etsy first.');
    }

    // Ensure we have a shop ID or name; prompt once if missing
    if (!etsyShopId) {
      const shopIdInput = prompt('Enter your Etsy Shop ID or Shop Name (e.g., MarketNestStudio):');
      if (!shopIdInput) {
        throw new Error('Etsy Shop ID or Name is required');
      }
      etsyShopId = shopIdInput.trim();
      localStorage.setItem('etsy_shop_id', etsyShopId);
    }

    // Resolve shop name to numeric id if needed
    let numericShopId = /^\d+$/.test(String(etsyShopId)) ? parseInt(etsyShopId) : null;
    if (!numericShopId) {
      console.log('[ETSY] Resolving shop name to ID:', etsyShopId);
      const resolveRes = await fetch('/.netlify/functions/etsy-resolve-shop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Etsy-Token': etsyToken
        },
        body: JSON.stringify({ shop_name: etsyShopId })
      });
      const resolveData = await resolveRes.json().catch(() => ({}));
      if (!resolveRes.ok || !resolveData?.success || !resolveData?.shop_id) {
        console.error('[ETSY] Failed to resolve shop name', resolveData);
        throw new Error('Could not resolve Etsy shop name to ID. Please enter numeric Shop ID.');
      }
      numericShopId = resolveData.shop_id;
      localStorage.setItem('etsy_shop_id', String(numericShopId));
      console.log('[ETSY] Resolved shop_id:', numericShopId);
    }

    // Build image URLs array
    const imageUrls = [];
    if (mockupUrl) {
      imageUrls.push(mockupUrl);
    }
    if (Array.isArray(productData.mockups)) {
      productData.mockups.forEach(mockup => {
        const url = typeof mockup === 'string' ? mockup : mockup?.url;
        if (url && !imageUrls.includes(url)) {
          imageUrls.push(url);
        }
      });
    }

    // Build Etsy listing payload
    const etsyPayload = {
      title: title,
      description: productData.description || `${title} - Custom Design`,
      price: retailPrice,
      quantity: 1,
      who_made: 'i_did',
      when_made: '2020_2024',
      taxonomy_id: 1, // Default category; can be customized per product type
      image_urls: imageUrls,
      shop_id: numericShopId,
      type: 'physical',
      is_supply: false,
      should_auto_renew: true,
      tags: Array.isArray(productData?.tags) ? productData.tags.slice(0, 13) : [],
      materials: Array.isArray(productData?.materials) ? productData.materials.slice(0, 13) : []
    };

    // Attach shipping profile
    try {
      const storedShipId = localStorage.getItem('etsy_shipping_profile_id');
      const storedShipName = localStorage.getItem('etsy_shipping_profile_name') || 'Printful';
      if (storedShipId && /^\d+$/.test(storedShipId)) {
        etsyPayload.shipping_profile_id = Number(storedShipId);
      } else {
        etsyPayload.shipping_profile_name = storedShipName;
      }
    } catch {}

    console.log('[ETSY] Sending to Etsy with payload:', etsyPayload);

    // Call Etsy function
    // Pass both the app token (for Supabase auth) and Etsy token (for Etsy API)
    const headers = {
      'Content-Type': 'application/json',
      'X-Etsy-Token': etsyToken // Pass Etsy token in custom header
    };
    
    // Add app auth header if available
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch('/.netlify/functions/etsy-create-listing', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(etsyPayload)
    });

    console.log('[ETSY] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[ETSY] HTTP error:', response.status, errorText);

      // Check if token is expired - trigger re-auth
      if (errorText.includes('invalid_token') || errorText.includes('access token is expired') || errorText.includes('token expired')) {
        console.log('[ETSY] Token expired, clearing token and prompting re-auth...');
        localStorage.removeItem('etsy_access_token');
        localStorage.removeItem('etsy_refresh_token');
        updateEtsyAuthButton();

        alert('⚠️ Your Etsy authorization has expired. Please click "Connect Etsy" in the navigation bar to re-authorize.');
        etsyBtn.disabled = false;
        etsyBtn.innerHTML = originalText;
        return;
      }

      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const result = await response.json();
    console.log('[ETSY] Parsed result:', result);

    if (result.success) {
      console.log(`✅ Product sent to Etsy successfully`);
      etsyBtn.disabled = true;
      etsyBtn.innerHTML = `<i class="bi bi-check-circle"></i> Sent to Etsy`;
      etsyBtn.classList.remove('btn-info');
      etsyBtn.classList.add('btn-secondary');

      // Show success message with link
      const listingUrl = result.listing_url || `https://www.etsy.com/listing/${result.listing_id}`;
      alert(`✅ Product sent to Etsy!\n\nListing URL: ${listingUrl}\n\nImages uploaded: ${result.images_uploaded}`);
    } else {
      console.error(`❌ Etsy send failed:`, result.error);

      // Check if error message indicates expired token
      const errorMsg = result.error || '';
      if (errorMsg.includes('invalid_token') || errorMsg.includes('access token is expired') || errorMsg.includes('token expired')) {
        console.log('[ETSY] Token expired (from result), clearing token and prompting re-auth...');
        localStorage.removeItem('etsy_access_token');
        localStorage.removeItem('etsy_refresh_token');
        updateEtsyAuthButton();

        alert('⚠️ Your Etsy authorization has expired. Please click "Connect Etsy" in the navigation bar to re-authorize.');
        etsyBtn.disabled = false;
        etsyBtn.innerHTML = originalText;
        return;
      }

      throw new Error(result.error || 'Unknown error');
    }

  } catch (err) {
    console.error('[ETSY] Error:', err);

    // Check if error message indicates expired token (final catch-all)
    if (err.message && (err.message.includes('invalid_token') || err.message.includes('access token is expired') || err.message.includes('token expired'))) {
      alert('⚠️ Your Etsy authorization has expired. You will be redirected to re-authorize with Etsy.');
      // This might have already redirected above, but just in case
    } else {
      alert(`❌ Failed to send to Etsy: ${err.message}\n\nCheck the browser console for details.`);
    }

    etsyBtn.disabled = false;
    etsyBtn.innerHTML = originalText;
  }
}

/**
 * Builds the product payload for Printful product creation.
 * @param {string} productId - The catalog product ID
 * @param {number} markup - The markup percentage
 * @param {string} mockupUrl - URL to the mockup image
 * @param {string} title - Product title
 * @returns {Promise<Object>} Product payload
 */
async function buildProductPayload(productId, markup, mockupUrl, title) {
  const product = allProducts.find(p => String(p.id) === String(productId));
  const content = state.productContent?.[productId] || {};
  const designs = state.productDesigns?.[productId] || [];

  if (!product) {
    throw new Error(`Product ${productId} not found in catalog`);
  }

  if (designs.length === 0) {
    throw new Error(`No designs selected for product ${productId}`);
  }

  // Get first variant (could be enhanced to support multiple variants)
  const variant = Array.isArray(product.variants) && product.variants.length > 0 
    ? product.variants[0] 
    : null;

  if (!variant) {
    throw new Error(`No variants found for product ${productId}`);
  }

  // Build placement files from designs
  const placementFiles = designs.map(design => {
    const imageUrl = state.generatedImages?.[`${productId}_${design.position}`];
    
    if (!imageUrl) {
      console.warn(`No image found for ${productId}_${design.position}, using mockup`);
    }

    return {
      placement: design.position,
      image_url: imageUrl || mockupUrl,
      width: design.width,
      height: design.height
    };
  });

  return {
    title: content.title || title || product.title,
    description: content.description || `${product.title} with custom design`,
    tags: content.tags || [],
    catalog_product_id: product.id,
    catalog_variant_id: variant.id,
    placement_files: placementFiles,
    key_features: content.key_features || [],
    materials: content.materials || [],
    markup_percentage: markup
  };
}

/**
 * Finalizes the process, perhaps showing a summary or navigating away.
 */
function finishBulkProcess() {
  alert('Bulk process finished!');
  console.log('finishBulkProcess() called.');
  navigateToStep(2); // Go back to the start
  state.completedSteps.clear();
  state.selectedProducts.clear();
  saveState();
}

// ============================================================================
// 5. MODAL DIALOG FUNCTIONS
// ============================================================================

function saveFineTune() {
  alert('saveFineTune() needs to be implemented.');
  console.log('saveFineTune() called.');
}

function applyFineTuneAndRegenerate() {
  alert('applyFineTuneAndRegenerate() needs to be implemented.');
  console.log('applyFineTuneAndRegenerate() called.');
}

function saveVariantImageMatrix() {
  alert('saveVariantImageMatrix() needs to be implemented.');
  console.log('saveVariantImageMatrix() called.');
}

function saveManageImages() {
  alert('saveManageImages() needs to be implemented.');
  console.log('saveManageImages() called.');
}

function confirmPrepublish() {
  alert('confirmPrepublish() needs to be implemented.');
  console.log('confirmPrepublish() called.');
}

// ============================================================================
// 6. HELPER & UTILITY FUNCTIONS
// ============================================================================

/**
 * Loads products from the Printful API using v1 endpoint (official recommendation).
 * Updated to follow the official API documentation response structure.
 */
async function loadProductsForShop() {
  console.log('[PRODUCTS] Loading products from Printful API v1...');
  const container = document.getElementById('step2-container');
  const content = document.querySelector('#step2-container .product-grid');
  const loader = document.querySelector('#step2-container .loader');

  // Create or find a progress element
  let progressText = document.getElementById('product-load-progress');
  if (!progressText && loader) {
    progressText = document.createElement('p');
    progressText.id = 'product-load-progress';
    progressText.className = 'text-center mt-2 text-muted';
    loader.appendChild(progressText);
  }

  try {
    if (loader) loader.style.display = 'block';
    if (content) content.innerHTML = '';
    if (progressText) progressText.textContent = 'Fetching product list...';

    // Use only a single API call to get the product summaries
    console.log('[PRODUCTS] Using v1 /products endpoint...');
    const summaryResponse = await makeApiCall('/products');
    console.log('[PRODUCTS] Raw v1 response:', summaryResponse);
    
    if (!summaryResponse || !summaryResponse.result) {
      throw new Error('Invalid summary response from /products');
    }
    
    const productSummaries = summaryResponse.result;

    if (productSummaries.length === 0) {
      allProducts = [];
      applyFilters();
      if (progressText) progressText.textContent = 'No products found.';
      return;
    }

    // Use the summary data directly without making individual product detail requests
    allProducts = productSummaries.map(p => ({
      id: p.id,
      title: p.title,
      brand: p.brand || '',
      model: p.model || '',
      image: p.image || p.thumbnail_url || '',
      images: p.image ? [p.image] : [],
      variants: p.variant_count || 0,
      techniques: p.techniques || [],
      files: p.files || [],
      category: p.main_category_id || p.category || '',
      type: p.type || '',
      type_name: p.type_name || '',
      is_discontinued: p.is_discontinued || false,
      description: p.description || '',
      avg_fulfillment_time: p.avg_fulfillment_time || 0,
      currency: p.currency || 'USD'
    }));

    console.log(`[PRODUCTS] Successfully processed ${allProducts.length} products`);
    if (progressText) progressText.textContent = '';
    applyFilters();
    updateRateLimitIndicator();

  } catch (error) {
    console.error('[PRODUCTS] Failed to load products:', error.message);
    console.error('[PRODUCTS] Error details:', error);
    
    if (content) {
      content.innerHTML = `
        <div class="alert alert-danger">
          <h5>Unable to Load Products</h5>
          <p><strong>API Error:</strong> ${error.message}</p>
          <p>This could be due to:</p>
          <ul>
            <li>OAuth token expired or invalid</li>
            <li>Missing API permissions</li>
            <li>Printful service temporarily unavailable</li>
            <li>Rate limit exceeded</li>
          </ul>
          <button class="btn btn-primary" onclick="loadProductsForShop()">Try Again</button>
          <button class="btn btn-secondary ms-2" onclick="window.location.reload()">Refresh Page</button>
        </div>`;
    }
  } finally {
    if (loader) loader.style.display = 'none';
  }
}

/**
 * Initializes all filter UI elements and event listeners.
 * Called after products are loaded in Step 2.
 */
function initializeFilters() {
  console.log('[FILTERS] Initializing filter UI...');
  
  // 1. Search input
  const searchInput = document.getElementById('productSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      applyFilters();
      renderProductsPage();
      updateFilterCount();
    });
  }

  // 2. Brand filters (dynamic checkboxes)
  const brandFilters = document.getElementById('brandFilters');
  if (brandFilters && allProducts.length > 0) {
    const brands = [...new Set(allProducts.map(p => p.brand).filter(Boolean))].sort();
    brandFilters.innerHTML = brands.map(brand => `
      <div class="form-check">
        <input class="form-check-input brand-filter" type="checkbox" value="${brand}" id="brand_${brand}">
        <label class="form-check-label" for="brand_${brand}">${brand || 'Unknown'}</label>
      </div>
    `).join('');
    
    brandFilters.querySelectorAll('.brand-filter').forEach(input => {
      input.addEventListener('change', () => {
        applyFilters();
        renderProductsPage();
        updateFilterCount();
      });
    });
  }

  // 3. Type filters (dynamic checkboxes)
  const typeFilters = document.getElementById('typeFilters');
  if (typeFilters && allProducts.length > 0) {
    const types = [...new Set(allProducts.map(p => p.type_name).filter(Boolean))].sort();
    typeFilters.innerHTML = types.map(type => `
      <div class="form-check">
        <input class="form-check-input type-filter" type="checkbox" value="${type}" id="type_${type}">
        <label class="form-check-label" for="type_${type}">${type}</label>
      </div>
    `).join('');
    
    typeFilters.querySelectorAll('.type-filter').forEach(input => {
      input.addEventListener('change', () => {
        applyFilters();
        renderProductsPage();
        updateFilterCount();
      });
    });
  }

  // 4. Technique filter (pre-defined select)
  const techniqueSelect = document.getElementById('techniqueSelect');
  if (techniqueSelect) {
    techniqueSelect.addEventListener('change', () => {
      updateTechniqueCount();
      applyFilters();
      renderProductsPage();
      updateFilterCount();
    });
  }

  // 5. Placement filter (pre-defined select)
  const placementSelect = document.getElementById('placementSelect');
  if (placementSelect) {
    placementSelect.addEventListener('change', () => {
      updatePlacementCount();
      applyFilters();
      renderProductsPage();
      updateFilterCount();
    });
  }

  // 6. Model filters (dynamic checkboxes)
  const modelFilters = document.getElementById('modelFilters');
  if (modelFilters && allProducts.length > 0) {
    const models = [...new Set(allProducts.map(p => p.model).filter(Boolean))].sort();
    modelFilters.innerHTML = models.map(model => `
      <div class="form-check">
        <input class="form-check-input model-filter" type="checkbox" value="${model}" id="model_${model}">
        <label class="form-check-label" for="model_${model}">${model}</label>
      </div>
    `).join('');
    
    modelFilters.querySelectorAll('.model-filter').forEach(input => {
      input.addEventListener('change', () => {
        applyFilters();
        renderProductsPage();
        updateFilterCount();
      });
    });
  }

  // 7. Category filters (dynamic checkboxes)
  const categoryFilters = document.getElementById('categoryFilters');
  if (categoryFilters && allProducts.length > 0) {
    const categories = [...new Set(allProducts.map(p => p.category).filter(Boolean))].sort();
    categoryFilters.innerHTML = categories.map(category => `
      <div class="form-check">
        <input class="form-check-input category-filter" type="checkbox" value="${category}" id="category_${category}">
        <label class="form-check-label" for="category_${category}">${category}</label>
      </div>
    `).join('');
    
    categoryFilters.querySelectorAll('.category-filter').forEach(input => {
      input.addEventListener('change', () => {
        applyFilters();
        renderProductsPage();
        updateFilterCount();
      });
    });
  }

  // 8. Reset filters button
  const resetBtn = document.getElementById('resetFiltersBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      // Clear all checkboxes
      document.querySelectorAll('.brand-filter, .type-filter, .model-filter, .category-filter').forEach(cb => {
        cb.checked = false;
      });
      // Clear select elements
      document.getElementById('techniqueSelect').selectedIndex = -1;
      document.getElementById('placementSelect').selectedIndex = -1;
      // Clear search
      document.getElementById('productSearchInput').value = '';
      // Re-apply filters
      applyFilters();
      renderProductsPage();
      updateFilterCount();
      updateTechniqueCount();
      updatePlacementCount();
    });
  }

  console.log('[FILTERS] Filter initialization complete');
}

/**
 * Updates the technique selected count badge.
 */
function updateTechniqueCount() {
  const techniqueSelect = document.getElementById('techniqueSelect');
  const countBadge = document.getElementById('techniqueSelectedCount');
  if (techniqueSelect && countBadge) {
    const selectedCount = Array.from(techniqueSelect.selectedOptions).length;
    countBadge.textContent = selectedCount;
  }
}

/**
 * Updates the placement selected count badge.
 */
function updatePlacementCount() {
  const placementSelect = document.getElementById('placementSelect');
  const countBadge = document.getElementById('placementSelectedCount');
  if (placementSelect && countBadge) {
    const selectedCount = Array.from(placementSelect.selectedOptions).length;
    countBadge.textContent = selectedCount;
  }
}

/**
 * Updates the filter count display.
 */
function updateFilterCount() {
  const techniques = Array.from(document.getElementById('techniqueSelect')?.selectedOptions || []).length;
  const placements = Array.from(document.getElementById('placementSelect')?.selectedOptions || []).length;
  const brands = document.querySelectorAll('.brand-filter:checked').length;
  const types = document.querySelectorAll('.type-filter:checked').length;
  const models = document.querySelectorAll('.model-filter:checked').length;
  const categories = document.querySelectorAll('.category-filter:checked').length;
  const search = document.getElementById('productSearchInput')?.value.length > 0 ? 1 : 0;
  
  const total = techniques + placements + brands + types + models + categories + search;
  
  const countEl = document.getElementById('filterCount');
  if (countEl) {
    if (total > 0) {
      countEl.textContent = `${total} filter${total !== 1 ? 's' : ''} applied`;
      countEl.classList.add('text-warning');
    } else {
      countEl.textContent = 'No filters applied';
      countEl.classList.remove('text-warning');
    }
  }
}

/**
 * Filters and re-renders the product list.
 * Applies all active filters: search, brand, type, technique, placement, model, category.
 */
function applyFilters() {
  // Get filter values from UI
  const searchFilter = document.getElementById('productSearchInput')?.value?.toLowerCase() || '';
  const selectedBrands = Array.from(document.querySelectorAll('.brand-filter:checked')).map(cb => cb.value);
  const selectedTypes = Array.from(document.querySelectorAll('.type-filter:checked')).map(cb => cb.value);
  const selectedTechniques = Array.from(document.getElementById('techniqueSelect')?.selectedOptions || []).map(opt => opt.value);
  const selectedPlacements = Array.from(document.getElementById('placementSelect')?.selectedOptions || []).map(opt => opt.value);
  const selectedModels = Array.from(document.querySelectorAll('.model-filter:checked')).map(cb => cb.value);
  const selectedCategories = Array.from(document.querySelectorAll('.category-filter:checked')).map(cb => cb.value);

  filteredProducts = allProducts.filter(product => {
    // Search filter (title, brand, model)
    if (searchFilter) {
      const searchableText = `${product.title} ${product.brand} ${product.model}`.toLowerCase();
      if (!searchableText.includes(searchFilter)) {
        return false;
      }
    }

    // Brand filter
    if (selectedBrands.length > 0 && !selectedBrands.includes(product.brand)) {
      return false;
    }

    // Type filter
    if (selectedTypes.length > 0 && !selectedTypes.includes(product.type_name)) {
      return false;
    }

    // Technique filter
    if (selectedTechniques.length > 0) {
      const productTechniques = Array.isArray(product.techniques) 
        ? product.techniques.map(t => t.key?.toUpperCase() || t.toUpperCase())
        : [];
      const hasMatchingTechnique = selectedTechniques.some(tech => 
        productTechniques.some(pt => pt === tech.toUpperCase())
      );
      if (!hasMatchingTechnique) {
        return false;
      }
    }

    // Placement filter (check if product has any of the selected placements)
    if (selectedPlacements.length > 0) {
      // For now, we'll skip this filter as placement data is in print areas
      // This could be enhanced by checking product capabilities
    }

    // Model filter
    if (selectedModels.length > 0 && !selectedModels.includes(product.model)) {
      return false;
    }

    // Category filter
    if (selectedCategories.length > 0 && !selectedCategories.includes(product.category)) {
      return false;
    }

    return true;
  });

  console.log(`[FILTERS] Filtered ${filteredProducts.length} products from ${allProducts.length} total`);
  currentPage = 1; // Reset to first page when filtering
  renderProductsPage();
}

/**
 * Navigates to a specific page and re-renders the product grid.
 * @param {number} page - The page number to navigate to (1-indexed)
 */
function goToPage(page) {
  const totalPages = Math.ceil(filteredProducts.length / productsPerPage);
  
  // Validate page number
  if (page < 1 || page > totalPages || isNaN(page)) {
    console.warn(`[PAGINATION] Invalid page number: ${page}. Total pages: ${totalPages}`);
    return;
  }
  
  currentPage = page;
  console.log(`[PAGINATION] Navigating to page ${currentPage} of ${totalPages}`);
  
  renderProductsPage();
  renderPagination();
  
  // Scroll to top of product grid
  const grid = document.getElementById('productsGrid');
  if (grid) {
    grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/**
 * Renders the pagination controls.
 * Shows previous/next buttons and page numbers.
 */
function renderPagination() {
  const container = document.getElementById('paginationContainer');
  if (!container) return;
  
  const totalPages = Math.ceil(filteredProducts.length / productsPerPage);
  
  // Don't show pagination if only one page
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }
  
  let html = '<nav aria-label="Product pagination"><ul class="pagination justify-content-center">';
  
  // Previous button
  if (currentPage > 1) {
    html += `<li class="page-item"><a class="page-link" href="#" onclick="goToPage(${currentPage - 1}); return false;" aria-label="Previous"><span aria-hidden="true">&laquo;</span> Previous</a></li>`;
  } else {
    html += '<li class="page-item disabled"><span class="page-link" aria-disabled="true"><span aria-hidden="true">&laquo;</span> Previous</span></li>';
  }
  
  // Page numbers (show up to 7 pages)
  const maxPagesToShow = 7;
  let startPage = Math.max(1, currentPage - Math.floor(maxPagesToShow / 2));
  let endPage = Math.min(totalPages, startPage + maxPagesToShow - 1);
  
  // Adjust start if we're near the end
  if (endPage - startPage + 1 < maxPagesToShow) {
    startPage = Math.max(1, endPage - maxPagesToShow + 1);
  }
  
  // Show first page if not visible
  if (startPage > 1) {
    html += `<li class="page-item"><a class="page-link" href="#" onclick="goToPage(1); return false;">1</a></li>`;
    if (startPage > 2) {
      html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
    }
  }
  
  // Show page numbers
  for (let i = startPage; i <= endPage; i++) {
    if (i === currentPage) {
      html += `<li class="page-item active"><span class="page-link">${i} <span class="visually-hidden">(current)</span></span></li>`;
    } else {
      html += `<li class="page-item"><a class="page-link" href="#" onclick="goToPage(${i}); return false;">${i}</a></li>`;
    }
  }
  
  // Show last page if not visible
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      html += '<li class="page-item disabled"><span class="page-link">...</span></li>';
    }
    html += `<li class="page-item"><a class="page-link" href="#" onclick="goToPage(${totalPages}); return false;">${totalPages}</a></li>`;
  }
  
  // Next button
  if (currentPage < totalPages) {
    html += `<li class="page-item"><a class="page-link" href="#" onclick="goToPage(${currentPage + 1}); return false;" aria-label="Next">Next <span aria-hidden="true">&raquo;</span></a></li>`;
  } else {
    html += '<li class="page-item disabled"><span class="page-link" aria-disabled="true">Next <span aria-hidden="true">&raquo;</span></span></li>';
  }
  
  html += '</ul></nav>';
  
  container.innerHTML = html;
  
  console.log(`[PAGINATION] Rendered pagination: page ${currentPage} of ${totalPages}`);
}

/**
 * Renders the current page of products in the grid.
 */
function renderProductsPage() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  const start = (currentPage - 1) * productsPerPage;
  const end = start + productsPerPage;
  const pageProducts = filteredProducts.slice(start, end);

  const region = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_selling_region')) || 'united_states';
  const abbr = regionAbbr(region);

  grid.innerHTML = pageProducts.map(p => {
    // Handle image URL
    let imageUrl = 'https://placehold.co/300x300?text=No+Image';
    if (p.image) {
      imageUrl = p.image;
    } else if (p.images && Array.isArray(p.images) && p.images.length > 0) {
      imageUrl = p.images[0];
    }

    const isChecked = state.selectedProducts.has(String(p.id));
    const hasVariants = p.variants > 0;
    const hasTechniques = p.techniques && p.techniques.length > 0;

    return `
      <div class="col-md-4 col-lg-3 mb-4">
        <div class="card h-100">
          <div class="position-relative">
            <img src="${imageUrl}" class="card-img-top" alt="${p.title}" onerror="this.src='https://placehold.co/300x300?text=No+Image'">
            <div class="region-badge" title="${region}">${abbr}</div>
            ${hasVariants ? `<div class="variant-badge" title="${p.variants} variants">${p.variants}v</div>` : ''}
            ${p.is_discontinued ? '<div class="discontinued-badge">DISC</div>' : ''}
          </div>
          <div class="card-body">
            <h6 class="card-title small">${p.title}</h6>
            ${p.brand ? `<p class="text-muted small mb-1">${p.brand}${p.model ? ` - ${p.model}` : ''}</p>` : ''}
            <p class="text-muted small mb-1">${p.type_name || p.type || 'Product'}</p>
            ${hasTechniques ? `<div class="technique-badges mb-2">${p.techniques.slice(0, 2).map(t => `<span class="badge badge-secondary small" style="background-color: ${getTechniqueColor(t.key.toLowerCase())}">${t.display_name || t.key}</span>`).join(' ')}</div>` : ''}
            ${p.avg_fulfillment_time ? `<small class="text-info">~${p.avg_fulfillment_time} days</small>` : ''}
          </div>
          <div class="card-footer">
            <div class="form-check">
              <input class="form-check-input product-checkbox" type="checkbox" id="product-${p.id}" value="${p.id}" onchange="toggleProduct(${p.id}, this.checked)" ${isChecked ? 'checked' : ''}>
              <label class="form-check-label" for="product-${p.id}">Select</label>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  updateSelectedCount();
  renderPagination();  // Render pagination after grid updates
}

/**
 * Toggles a product's selection state.
 */
function toggleProduct(productId, isChecked) {
  const idStr = String(productId);
  if (isChecked) {
    state.selectedProducts.add(idStr);
  } else {
    state.selectedProducts.delete(idStr);
  }
  saveState();
  updateSelectedCount();
}

/**
 * Updates the UI element showing the number of selected products.
 */
function updateSelectedCount() {
  const countEl = document.getElementById('selectedCount');
  if (countEl) {
    countEl.textContent = state.selectedProducts.size;
  }
  const continueBtn = document.getElementById('selectProductsBtn');
  if (continueBtn) {
    continueBtn.disabled = state.selectedProducts.size === 0;
  }
}

/**
 * Generic wrapper for making API calls to the Netlify proxy function.
 * Updated to handle proper Printful v1 API response structure.
 * @param {string} endpoint - The Printful API endpoint (e.g., '/products').
 * @param {object} options - Fetch options (method, body, etc.).
 * @returns {Promise<any>} - The JSON response data.
 */
async function makeApiCall(endpoint, options = {}) {
    const token = localStorage.getItem('authToken');
    
    try {
        const resp = await fetch('/.netlify/functions/printful-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({
                endpoint,
                method: options.method || 'GET',
                body: options.body || null,
                headers: options.headers || {}
            })
        });

        const proxyResponseText = await resp.text();
        let proxyResponse;
        try {
            proxyResponse = JSON.parse(proxyResponseText);
        } catch (e) {
            console.error('[makeApiCall] Failed to parse proxy JSON response:', proxyResponseText);
            throw new Error('Invalid response from server proxy.');
        }

        console.log(`[makeApiCall] Proxy response for ${endpoint}:`, proxyResponse);

        // Handle errors returned from the proxy itself
        if (!proxyResponse.success) {
            const errorDetail = proxyResponse.details || proxyResponse.error || 'Unknown proxy error';
            console.error(`[makeApiCall] Proxy returned an error for ${endpoint}:`, errorDetail);
            throw new Error(typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail);
        }

        // The actual Printful data is nested in the 'data' property
        const printfulData = proxyResponse.data;

        // Handle Printful API-level errors (e.g., { code: 404, result: 'Not Found' })
        if (printfulData && printfulData.code && printfulData.code !== 200) {
            const errorMessage = printfulData.result || `Printful API Error Code: ${printfulData.code}`;
            console.error(`[makeApiCall] Printful API error for ${endpoint}:`, errorMessage);
            throw new Error(typeof errorMessage === 'object' ? JSON.stringify(errorMessage) : errorMessage);
        }

        // Return the actual, unwrapped Printful data
        return printfulData;

    } catch (error) {
        console.error(`[makeApiCall] Final catch for ${endpoint}:`, error.message);
        throw error; // Re-throw the error to be caught by the calling function
    }
}

/**
 * Clears the session storage and reloads the page to start a new bulk job.
 */
function startNewJob() {
  if (confirm('Are you sure you want to start over? All unsaved progress will be lost.')) {
    resetState();
    // Also clear any other cached data
    localStorage.removeItem('pf_selling_region');
    localStorage.removeItem('authToken');
    sessionStorage.clear();
    // Reload the page to ensure complete reset
    window.location.reload();
  }
}

// Region abbreviation helper to mirror modules UI
function regionAbbr(code) {
  try {
    const map = {
      worldwide: 'WW',
      north_america: 'NA',
      united_states: 'US',
      europe: 'EU',
      australia: 'AU',
      japan: 'JP',
      uk: 'UK',
      united_kingdom: 'UK',
      france: 'FR',
      germany: 'DE',
      canada: 'CA',
      new_zealand: 'NZ',
      italy: 'IT',
      brazil: 'BR',
      southeast_asia: 'SEA',
      republic_of_korea: 'KR',
      spain: 'ES',
      latvia: 'LV'
    };
    const key = String(code || '').toLowerCase();
    return map[key] || key.toUpperCase().slice(0, 2);
  } catch { return 'RG'; }
}

/**
 * Updates the rate limit indicator in the UI
 */
function updateRateLimitIndicator() {
  try {
    const rateLimitData = localStorage.getItem('printful_rate_limit');
    if (!rateLimitData) return;

    const rateLimit = JSON.parse(rateLimitData);
    const indicator = document.getElementById('rateLimitIndicator');
    if (!indicator) return;

    const remaining = parseInt(rateLimit.remaining, 10) || 0;
    const limit = parseInt(rateLimit.limit, 10) || 120;
    const resetTime = rateLimit.reset ? new Date(parseInt(rateLimit.reset, 10) * 1000) : null;

    let className = 'rate-limit-info';
    let message = `API: ${remaining}/${limit}`;

    if (remaining < 20) {
      className += ' rate-limit-warning';
      message += ' ⚠️';
    } else if (remaining < 10) {
      className += ' rate-limit-danger';
      message += ' 🚫';
    }

    if (resetTime) {
      const now = new Date();
      const diffMs = resetTime.getTime() - now.getTime();
      if (diffMs > 0) {
        const diffMin = Math.ceil(diffMs / 60000);
        message += ` (${diffMin}m)`;
      }
    }

    indicator.className = className;
    indicator.textContent = message;
    indicator.classList.remove('d-none');

    // Auto-hide after 30 seconds if rate limit is healthy
    if (remaining > 50) {
      setTimeout(() => {
        indicator.classList.add('d-none');
      }, 30000);
    }
  } catch (e) {
    console.warn('Failed to update rate limit indicator:', e);
  }
}

// Update rate limit indicator periodically
setInterval(updateRateLimitIndicator, 5000);

/**
 * Fetches detailed product information including variants on demand
 * This prevents excessive API calls during initial product loading
 * @param {string|number} productId - The product ID to fetch details for
 * @returns {Promise<Object>} - The product with variants
 */
async function getProductWithVariants(productId) {
  if (!productId) return null;

  const sellingRegion = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_selling_region')) || 'usa';

  // Check if we already have detailed product info with variants from the catalog API
  const existingProduct = allProducts.find(p => String(p.id) === String(productId));
  if (existingProduct && existingProduct._catalogProduct && Array.isArray(existingProduct.variants) && existingProduct.variants.length > 0) {
    console.log(`[PRODUCT-DETAIL] Using cached v2 catalog product with variants for ${productId}`);
    return existingProduct;
  }

  try {
    console.log(`[PRODUCT-DETAIL] Fetching catalog details for product ${productId} (region: ${sellingRegion})`);
    const productRes = await makeApiCall(`/v2/catalog-products/${productId}?selling_region_name=${sellingRegion}`);
    const productData = productRes?.data;

    if (!productData) {
      console.error(`[PRODUCT-DETAIL] No data returned for catalog product ${productId}`, productRes);
      return null;
    }

    console.log(`[PRODUCT-DETAIL] Fetching catalog variants for product ${productId}`);
    const variantsRes = await makeApiCall(`/v2/catalog-products/${productId}/catalog-variants?selling_region_name=${sellingRegion}`);
    const variantsArray = variantsRes?.data?.data || variantsRes?.data || [];
    const normalizedVariants = Array.isArray(variantsArray) ? variantsArray : [];

    console.log(`[PRODUCT-DETAIL] Fetched ${normalizedVariants.length} variants for product ${productId}`);

    const normalizedProduct = {
      id: productData.id,
      title: productData.name || productData.title || existingProduct?.title || '',
      brand: productData.brand || existingProduct?.brand || '',
      model: productData.model || existingProduct?.model || '',
      image: productData.image || existingProduct?.image || '',
      images: Array.isArray(productData.images) ? productData.images : (existingProduct?.images || []),
      description: productData.description || existingProduct?.description || '',
      variant_count: productData.variant_count || normalizedVariants.length,
      techniques: productData.techniques || [],
      placements: productData.placements || [],
      product_options: productData.product_options || [],
      variants: normalizedVariants,
      selling_region_name: sellingRegion,
      _catalogProduct: productData
    };

    // Update cache if product was previously there
    if (existingProduct) {
      allProducts = allProducts.map(p => (String(p.id) === String(productId) ? { ...existingProduct, ...normalizedProduct } : p));
      console.log(`[PRODUCT-DETAIL] Updated cached catalog product ${productId} with ${normalizedVariants.length} variants`);
      return allProducts.find(p => String(p.id) === String(productId));
    }

    // Add to cache if it wasn't there
    allProducts.push(normalizedProduct);
    console.log(`[PRODUCT-DETAIL] Added catalog product ${productId} to cache with ${normalizedVariants.length} variants`);
    return normalizedProduct;
  } catch (error) {
    console.error(`[PRODUCT-DETAIL] Error fetching catalog product ${productId}:`, error);
    return null;
  }
}

/**
 * Returns a color for different printing techniques
 */
function getTechniqueColor(technique) {
  const colors = {
    'dtg': '#2563eb',           // Blue - Direct to Garment
    'digital': '#2563eb',       // Blue - Digital printing
    'sublimation': '#dc2626',   // Red - Sublimation
    'embroidery': '#059669',    // Green - Embroidery
    'vinyl': '#7c3aed',         // Purple - Vinyl
    'screen': '#ea580c',        // Orange - Screen printing
    'heat-transfer': '#db2777', // Pink - Heat transfer
    'laser': '#6b7280',         // Gray - Laser engraving
    'uv': '#fbbf24',            // Yellow - UV printing
    'cut-sew': '#8b5cf6'        // Violet - Cut & Sew
  };
  return colors[technique.toLowerCase()] || '#6b7280'; // Default gray
}

/**
 * Toggle print area selection (checkbox)
 */
function togglePrintAreaSelection(productId, areaId) {
  const checkbox = document.getElementById(areaId);
  if (checkbox) {
    checkbox.checked = !checkbox.checked;
    updateSelectedPrintAreas(productId);
  }
}

/**
 * Select only this print area (deselect all others for this product)
 */
function selectOnlyPrintArea(productId, areaId) {
  // Find all checkboxes for this product
  const allCheckboxes = document.querySelectorAll(`input[data-product-id="${productId}"]`);
  
  // Uncheck all
  allCheckboxes.forEach(cb => cb.checked = false);
  
  // Check only the selected one
  const checkbox = document.getElementById(areaId);
  if (checkbox) {
    checkbox.checked = true;
  }
  
  updateSelectedPrintAreas(productId);
}

/**
 * Update the display of selected print areas for a product
 */
function updateSelectedPrintAreas(productId) {
  const selectedCheckboxes = document.querySelectorAll(`input[data-product-id="${productId}"]:checked`);
  console.log(`[PRINT AREAS] Product ${productId}: ${selectedCheckboxes.length} areas selected`);
  
  // Store selection in state for later use
  if (!window.state) window.state = {};
  if (!window.state.selectedPrintAreas) window.state.selectedPrintAreas = {};
  
  window.state.selectedPrintAreas[productId] = Array.from(selectedCheckboxes).map(cb => ({
    position: cb.dataset.position,
    width: parseInt(cb.dataset.width),
    height: parseInt(cb.dataset.height),
    technique: cb.dataset.technique
  }));
  
  console.log(`[PRINT AREAS] Stored selection:`, window.state.selectedPrintAreas[productId]);
};
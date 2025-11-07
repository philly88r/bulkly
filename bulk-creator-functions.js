/**
 * bulk-creator-functions.js
 * 
 * This file contains all the client-side JavaScript functions called by the inline 'onclick' 
 * handlers in 'bulkly.html'. It manages the application state, navigation, API calls, 
 * and UI updates for the bulk product creation workflow.
 */

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

document.addEventListener('DOMContentLoaded', init);

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
  container.innerHTML = '<div class="text-center"><div class="spinner-border"></div><p>Creating products…</p></div>';

  const token = localStorage.getItem('authToken');
  const products = [];

  // Build payload for pricing-orchestrator
  console.log('Building payload. state.productContent:', state.productContent);
  console.log('state.productDesigns:', state.productDesigns);
  
  for (const productId in state.productDesigns) {
    const placements = state.productDesigns[productId];
    const content   = state.productContent?.[productId] || {};
    const product   = allProducts.find(p => String(p.id) === String(productId));
    
    console.log(`Product ${productId}:`, {
      content,
      product,
      placements
    });
    
    if (!product) continue;

    for (const placement of placements) {
      const { position, width, height } = placement;
      const imageUrl = state.generatedImages?.[`${productId}_${position}`];
      const productPayload = {
        catalog_product_id : Number(productId),
        title            : content.title || `${product.title} – ${position}`,
        description      : content.description || '',
        tags             : content.tags || [],
        keyFeatures      : content.key_features || [],
        materials        : content.materials || [],
        placement,
        imageUrl,
        width,
        height,
        technique        : product.technique || 'sublimation',
        style_id         : product.style_id || null
      };
      console.log('Product payload being added:', productPayload);
      products.push(productPayload);
    }
  }

  console.log('Final payload being sent to pricing-orchestrator:', { products });
  
  try {
    const response = await fetch('/.netlify/functions/pricing-orchestrator', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body   : JSON.stringify({ products })
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

function renderPricingUI(products) {
  const box = document.getElementById('productsContainer');
  if (!box) return;
  box.innerHTML = '';
  products.forEach(p => {
    box.insertAdjacentHTML('beforeend', `
      <div class="card mb-3">
        <div class="card-header">${p.title}</div>
        <div class="card-body">
          <img src="${p.mockups?.[0]?.url || ''}" width="100" class="me-2">
          <p class="mb-1">Cost: $${p.cost}</p>
          <input type="number" class="form-control w-25 d-inline markup" value="40" min="1" max="500"> %
          <button class="btn btn-sm btn-success ms-2 publish-btn" data-id="${p.product_id}">Publish</button>
        </div>
      </div>
    `);
  });
}

/**
 * Initialize print areas step (Step 3)
 */
async function initializePrintAreas() {
  console.log('Initializing Step 3: Print Areas...');
  const container = document.getElementById('step3-container');
  if (!container) {
    console.error('Step 3 container not found!');
    return;
  }

  const selectedProductIds = Array.from(state.selectedProducts);
  if (selectedProductIds.length === 0) {
    container.innerHTML = '<div class="alert alert-warning">No products selected. Please go back to Step 2.</div>';
    return;
  }

  container.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div><p>Loading print areas...</p></div>';

  // Debug: Log selected product information
  console.log('[PRINT-AREAS] Selected products for print area loading:');
  selectedProductIds.forEach(id => {
    const product = allProducts.find(p => String(p.id) === id);
    console.log(`  - ID: ${id}, Found: ${!!product}, Title: ${product?.title || 'N/A'}`);
    if (product) {
      console.log(`    Type: ${product.type || 'N/A'}, Brand: ${product.brand || 'N/A'}`);
      console.log(`    Has print_areas: ${!!(product.print_areas)}, Count: ${product.print_areas?.length || 0}`);
    }
  });

  let allProductsHTML = '';
  for (const productId of selectedProductIds) {
    const product = allProducts.find(p => String(p.id) === productId);
    if (!product) continue;

    try {
      console.log(`Fetching print areas for product: ${product.title} (ID: ${productId})`);
      const printAreas = await fetchPrintAreasForProduct(productId);
      console.log(`Print areas result for ${productId}:`, printAreas);

      if (!printAreas || printAreas.length === 0) {
        console.warn(`No print areas returned for product ${productId} (${product.title})`);

        // Add debugging info about the product
        console.log('Product data:', {
          id: product.id,
          title: product.title,
          brand: product.brand,
          type: product.type,
          print_areas: product.print_areas
        });
      }

      const productHTML = renderProductPrintAreas(product, printAreas);
      allProductsHTML += productHTML;
    } catch (error) {
      console.error(`Failed to load print areas for product ${productId} (${product.title}):`, error);
      console.error('Error stack:', error.stack);
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

  // Add the continue button after rendering the products
  const footerHTML = `
    <div class="card-footer text-end mt-3">
      <button class="btn btn-primary" onclick="proceedToStep4()">Continue to Generation <i class="bi bi-arrow-right"></i></button>
    </div>`;
  container.insertAdjacentHTML('beforeend', footerHTML);
}

/**
 * Fetches the available print areas for a single product using Printful API.
 * @param {string} productId - The ID of the product.
 * @returns {Promise<Array>} A promise that resolves to an array of print area objects.
 */
async function fetchPrintAreasForProduct(productId) {
    console.log(`[PRINT-AREAS] Fetching print areas for product ${productId} (following Printful docs)`);

    // Validate productId
    if (!productId) {
        console.error('[PRINT-AREAS] No productId provided');
        throw new Error('Product ID is required');
    }

    const numericProductId = parseInt(productId, 10);
    if (isNaN(numericProductId)) {
        console.error(`[PRINT-AREAS] Invalid productId format: ${productId}`);
        throw new Error(`Invalid product ID format: ${productId}`);
    }

    console.log(`[PRINT-AREAS] Using product ID: ${numericProductId}`);

    // According to Printful docs: Get product details which includes print areas, techniques, and files
    try {
        console.log(`[PRINT-AREAS] Getting product details from /products/${numericProductId}`);
        const productRes = await makeApiCall(`/products/${numericProductId}`);
        console.log('[PRINT-AREAS] Product details response:', productRes);

        if (productRes && productRes.result) {
            const product = productRes.result;
            console.log('[PRINT-AREAS] Product structure analysis:', {
                id: product.id,
                title: product.title,
                hasVariants: !!product.variants,
                variantCount: product.variants?.length || 0,
                hasFiles: !!product.files,
                fileCount: product.files?.length || 0,
                hasTechniques: !!product.techniques,
                techniqueCount: product.techniques?.length || 0
            });

            // Extract print areas from product details (files array contains print specifications)
            const printAreas = [];

            // Method 1: Extract from product files array
            if (product.files && Array.isArray(product.files)) {
                console.log('[PRINT-AREAS] Processing files array:', product.files);
                product.files.forEach((file, index) => {
                    console.log(`[PRINT-AREAS] File ${index}:`, file);
                    printAreas.push({
                        position: file.type || file.title || `position_${index}`,
                        width: file.width || 3000,
                        height: file.height || 3000,
                        dpi: file.dpi || 300,
                        type: file.type || file.title,
                        technique: file.additional_price_breakdown?.technique || 'dtg'
                    });
                });
            }

            // Method 2: Extract from variants (each variant may have different print areas)
            if (product.variants && Array.isArray(product.variants) && printAreas.length === 0) {
                console.log('[PRINT-AREAS] Processing variants for print areas...');
                const variantPrintAreas = new Map();

                product.variants.forEach((variant, vIndex) => {
                    console.log(`[PRINT-AREAS] Variant ${vIndex}:`, {
                        id: variant.id,
                        hasFiles: !!variant.files,
                        fileCount: variant.files?.length || 0
                    });

                    if (variant.files && Array.isArray(variant.files)) {
                        variant.files.forEach(file => {
                            const key = `${file.type}_${file.width}_${file.height}`;
                            if (!variantPrintAreas.has(key)) {
                                variantPrintAreas.set(key, {
                                    position: file.type || file.title,
                                    width: file.width || 3000,
                                    height: file.height || 3000,
                                    dpi: file.dpi || 300,
                                    type: file.type || file.title,
                                    technique: file.additional_price_breakdown?.technique || 'dtg'
                                });
                            }
                        });
                    }
                });

                printAreas.push(...Array.from(variantPrintAreas.values()));
            }

            console.log(`[PRINT-AREAS] Extracted ${printAreas.length} print areas from product details:`, printAreas);
            if (printAreas.length > 0) {
                return printAreas;
            }
        }
    } catch (productError) {
        console.error('[PRINT-AREAS] Product details fetch failed:', productError.message);
    }

    // If no print areas found in basic product details, try custom endpoint as fallback
    console.warn(`[PRINT-AREAS] No print areas found in product details for ${numericProductId}`);

    // Try the original custom endpoint as fallback
    try {
        console.log(`[PRINT-AREAS] Trying custom endpoint: /.netlify/functions/get-print-area-specs`);
        const token = localStorage.getItem('authToken');
        const response = await fetch('/.netlify/functions/get-print-area-specs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ productId: numericProductId })
        });

        console.log(`[PRINT-AREAS] Custom endpoint response status: ${response.status}`);
        const data = await response.json();
        console.log('[PRINT-AREAS] Custom endpoint response data:', data);

        if (response.ok && data.success && data.printAreas) {
            console.log(`[PRINT-AREAS] Found ${data.printAreas.length} print areas from custom endpoint`);
            return data.printAreas.map(area => ({
                ...area,
                technique: area.technique || 'digital'
            }));
        } else {
            console.warn('[PRINT-AREAS] Custom endpoint failed or returned no data:', data);
        }
    } catch (customError) {
        console.warn('[PRINT-AREAS] Custom print areas endpoint failed:', customError.message);
        console.warn('[PRINT-AREAS] Custom error details:', customError);
    }

    // Final fallback - use product's print_areas if available
    const product = allProducts.find(p => String(p.id) === String(numericProductId));
    console.log(`[PRINT-AREAS] Checking product cache for ${numericProductId}:`, {
        found: !!product,
        title: product?.title,
        hasPrintAreas: !!(product?.print_areas),
        printAreasCount: product?.print_areas?.length || 0
    });

    if (product?.print_areas && product.print_areas.length > 0) {
        console.log(`[PRINT-AREAS] Using cached print areas from product data: ${product.print_areas.length} areas`);
        return product.print_areas.map(area => ({
            ...area,
            technique: area.technique || 'digital'
        }));
    }

    console.warn(`[PRINT-AREAS] No print areas found for product ${numericProductId} (${product?.title || 'unknown'}), using fallback`);
    // Default fallback areas with common techniques
    return [
        { position: 'front', width: 3000, height: 3000, dpi: 300, type: 'front', technique: 'dtg' },
        { position: 'back', width: 3000, height: 3000, dpi: 300, type: 'back', technique: 'dtg' }
    ];
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
              <strong>${area.position}</strong>
              <span class="text-muted small d-block">${area.width}x${area.height}px @ ${area.dpi || 300}dpi</span>
            </div>
            <span class="badge" style="background-color: ${techniqueColor}; color: white; font-size: 11px;">
              ${technique.toUpperCase()}
            </span>
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

        const contentRes = await fetch('/.netlify/functions/generate-content', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            prompt, style, colors, audience,
            contentType: 'product-content',
            productId: job.productId,
            productInfo: [job.product]
          })
        }).then(r => r.json());

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

      const imageRes = await fetch('/.netlify/functions/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          prompt, style, colors, audience,
          size: `${job.placement.width}x${job.placement.height}`,
          numImages: 1
        })
      }).then(r => r.json());

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
        imgUrl = await pollForImageResult(imageRes.request_id, token);
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

async function pollForImageResult(requestId, token, maxAttempts = 8, delay = 1000) {
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
        body: JSON.stringify({ statusOnly: true, requestId: requestId })
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
 */
function publishSelectedProducts() {
  alert('publishSelectedProducts() needs to be implemented.');
  console.log('publishSelectedProducts() called.');
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
 * Loads products from the Printful API using v2 endpoint.
 */
async function loadProductsForShop() {
  console.log('[PRODUCTS] Loading products from Printful API (following official docs)...');

  // According to Printful docs: Use v1 /products endpoint for basic catalog access
  try {
    console.log('[PRODUCTS] Using v1 /products endpoint (official recommendation)...');
    const res = await makeApiCall('/products');
    console.log('[PRODUCTS] Raw v1 response:', res);

    // Printful v1 API always returns: { code: number, result: array }
    if (res && Array.isArray(res.result)) {
      console.log(`[PRODUCTS] Found ${res.result.length} products in v1 result`);

      allProducts = res.result.map(p => ({
        id: p.id,
        title: p.title,
        brand: p.brand || '',
        model: p.model || '',
        images: p.image ? [p.image] : (p.thumbnail_url ? [p.thumbnail_url] : []),
        variants: p.variants || [],
        techniques: p.techniques || [],
        print_areas: [], // Will be loaded separately via print areas API
        category: p.category || '',
        type: p.type || p.product_type || ''
      }));

      console.log(`[PRODUCTS] Successfully processed ${allProducts.length} products`);
      applyFilters();
      updateRateLimitIndicator();
      return;
    } else {
      console.error('[PRODUCTS] v1 API response missing result array:', res);
      throw new Error('Invalid v1 API response structure');
    }

  } catch (v1Error) {
    console.error('[PRODUCTS] v1 /products API failed:', v1Error.message);
    console.error('[PRODUCTS] v1 error details:', v1Error);

    // Try v2 as fallback (but v1 should work for basic catalog access)
    try {
      console.log('[PRODUCTS] Trying v2 /catalog-products as fallback...');
      const res = await makeApiCall('/v2/catalog-products');
      console.log('[PRODUCTS] Raw v2 response:', res);

      // v2 API structure is different
      let productList = [];
      if (Array.isArray(res.data)) {
        productList = res.data;
      } else if (Array.isArray(res)) {
        productList = res;
      }

      console.log(`[PRODUCTS] Found ${productList.length} products in v2 response`);

      allProducts = productList.map(p => ({
        id: p.id,
        title: p.title,
        brand: p.brand || '',
        model: p.model || '',
        images: Array.isArray(p.images) ? p.images : [],
        variants: Array.isArray(p.variants) ? p.variants : [],
        techniques: Array.isArray(p.techniques) ? p.techniques : [],
        print_areas: [], // Will be loaded separately
        category: p.category || '',
        type: p.type || ''
      }));

      console.log(`[PRODUCTS] Successfully processed ${allProducts.length} products from v2`);
      applyFilters();
      updateRateLimitIndicator();
      return;

    } catch (v2Error) {
      console.error('[PRODUCTS] Both v1 and v2 API calls failed');
      console.error('[PRODUCTS] v1 error:', v1Error.message);
      console.error('[PRODUCTS] v2 error:', v2Error.message);

      // Show user-friendly error
      const container = document.getElementById('step2-container');
      if (container) {
        container.innerHTML = `
          <div class="alert alert-danger">
            <h5>Unable to Load Products</h5>
            <p><strong>API Error:</strong> ${v1Error.message}</p>
            <p>This could be due to:</p>
            <ul>
              <li>OAuth token expired or invalid</li>
              <li>Missing API permissions</li>
              <li>Printful service temporarily unavailable</li>
            </ul>
            <button class="btn btn-primary" onclick="loadProductsForShop()">Try Again</button>
            <button class="btn btn-secondary ms-2" onclick="window.location.reload()">Refresh Page</button>
          </div>`;
      }

      throw new Error(`Product loading failed: v1=${v1Error.message}, v2=${v2Error.message}`);
    }
  }
}

/**
 * Filters and re-renders the product list.
 */
function applyFilters() {
  // Get filter values from UI (if filter elements exist)
  const categoryFilter = document.getElementById('categoryFilter')?.value || '';
  const typeFilter = document.getElementById('typeFilter')?.value || '';
  const searchFilter = document.getElementById('searchFilter')?.value?.toLowerCase() || '';

  filteredProducts = allProducts.filter(product => {
    // Category filter
    if (categoryFilter && product.category && !product.category.toLowerCase().includes(categoryFilter.toLowerCase())) {
      return false;
    }

    // Type filter
    if (typeFilter && product.type && !product.type.toLowerCase().includes(typeFilter.toLowerCase())) {
      return false;
    }

    // Search filter (title, brand, model)
    if (searchFilter) {
      const searchableText = `${product.title} ${product.brand} ${product.model}`.toLowerCase();
      if (!searchableText.includes(searchFilter)) {
        return false;
      }
    }

    return true;
  });

  console.log(`Filtered ${filteredProducts.length} products from ${allProducts.length} total`);
  currentPage = 1; // Reset to first page when filtering
  renderProductsPage();
  updateRateLimitIndicator();
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
    // Handle both v1 and v2 image formats
    let imageUrl = 'https://placehold.co/300x300?text=No+Image';
    if (p.images && Array.isArray(p.images) && p.images.length > 0) {
      // v2 format: array of image objects or URLs
      const firstImage = p.images[0];
      imageUrl = typeof firstImage === 'string' ? firstImage : (firstImage?.url || firstImage?.src || imageUrl);
    } else if (p.image) {
      // v1 fallback format
      imageUrl = p.image;
    } else if (p.thumbnail_url) {
      // v1 thumbnail fallback
      imageUrl = p.thumbnail_url;
    }

    const isChecked = state.selectedProducts.has(String(p.id));
    const hasVariants = p.variants && p.variants.length > 0;
    const hasPrintAreas = p.print_areas && p.print_areas.length > 0;

    return `
      <div class="col-md-4 col-lg-3 mb-4">
        <div class="card h-100">
          <div class="position-relative">
            <img src="${imageUrl}" class="card-img-top" alt="${p.title}">
            <div class="region-badge" title="${region}">${abbr}</div>
            ${hasVariants ? `<div class="variant-badge" title="${p.variants.length} variants">${p.variants.length}v</div>` : ''}
          </div>
          <div class="card-body">
            <h6 class="card-title small">${p.title}</h6>
            ${p.brand ? `<p class="text-muted small mb-1">${p.brand}${p.model ? ` - ${p.model}` : ''}</p>` : ''}
            ${p.techniques && p.techniques.length > 0 ? `<div class="technique-badges">${p.techniques.slice(0, 2).map(t => `<span class="badge badge-secondary small">${t}</span>`).join(' ')}</div>` : ''}
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
 * A generic wrapper for making API calls to the Netlify proxy function.
 * @param {string} endpoint - The Printful API endpoint (e.g., '/v2/catalog-products').
 * @param {object} options - Fetch options (method, body, etc.).
 * @returns {Promise<any>} - The JSON response data.
 */
async function makeApiCall(endpoint, options = {}) {
  const token = localStorage.getItem('authToken');
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

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { success: false, error: 'Invalid JSON response from server.' };
  }

  if (!resp.ok || !data || data.success === false) {
    const errorMsg = (data && data.error) || `API Error: ${resp.status}`;
    console.error('API call failed:', { endpoint, status: resp.status, response: data });

    // Log rate limit info if available
    if (data && data.rateLimit) {
      console.warn('Rate limit info:', data.rateLimit);
      // Store rate limit info for UI display
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('printful_rate_limit', JSON.stringify(data.rateLimit));
      }
    }

    throw new Error(errorMsg);
  }

  // Store rate limit info from successful responses
  if (data && data.rateLimit && typeof localStorage !== 'undefined') {
    localStorage.setItem('printful_rate_limit', JSON.stringify(data.rateLimit));
  }

  // Handle different response structures
  if (data.data !== undefined) {
    return data.data;
  } else if (data.result !== undefined) {
    return data.result;
  } else {
    // Some endpoints return data directly
    return data;
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
    'uv': '#fbbf24'             // Yellow - UV printing
  };
  return colors[technique.toLowerCase()] || '#6b7280'; // Default gray
}

/**
 * Print Areas Step Controller
 * Handles all logic for Step 2: Print Area Selection
 */

class PrintAreasController {
  constructor(stateManager, apiClient) {
    this.state = stateManager;
    this.api = apiClient;
    
    this.initializeEventListeners();
  }

  /**
   * Render provider/region header controls (OAuth-based Printful integration)
   */
  renderProviderHeader() {
    const region = this.getSellingRegion() || 'north_america';
    return `
      <div class="card mb-3">
        <div class="card-body d-flex flex-wrap align-items-end gap-3">
          <div>
            <div class="form-text text-uppercase small">Print Provider</div>
            <div class="fw-bold">Printful (OAuth Connected)</div>
          </div>
          <div style="min-width:220px;">
            <label class="form-label mb-1">Selling Region</label>
            <select class="form-select form-select-sm" data-action="set-selling-region">
              ${this.renderRegionOption('north_america', region)}
              ${this.renderRegionOption('europe', region)}
              ${this.renderRegionOption('australia', region)}
              ${this.renderRegionOption('japan', region)}
            </select>
            <div class="form-text">Used for catalog and mockup style retrieval.</div>
          </div>
        </div>
      </div>
    `;
  }

  renderRegionOption(value, selected) {
    const isSel = String(value) === String(selected) ? 'selected' : '';
    const label = {
      north_america: 'North America',
      europe: 'Europe',
      australia: 'Australia',
      japan: 'Japan'
    }[value] || value;
    return `<option value="${value}" ${isSel}>${label}</option>`;
  }

  /**
   * Helper: extract array from various API response envelopes
   */
  arrayFromResponse(res) {
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.data)) return res.data;
    if (Array.isArray(res?.result)) return res.result;
    if (Array.isArray(res?.items)) return res.items;
    return [];
  }
  
  /**
   * Initialize the print areas step
   */
  async initialize() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    
    if (selectedProducts.size === 0) {
      this.state.updateState({
        error: 'Please select products first'
      });
      return;
    }
    
    try {
      this.state.updateState({ loading: true });
      
      // Load detailed product information including print areas
      await this.loadProductPrintAreas();
      
      this.state.updateState({ loading: false });
      this.renderPrintAreas();
      
    } catch (error) {
      console.error('Failed to initialize print areas:', error);
      this.state.updateState({
        loading: false,
        error: 'Failed to load print areas. Please try again.'
      });
    }
  }
  
  /**
   * Load print areas for selected products
   */
  async loadProductPrintAreas() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const allProducts = this.state.getStateSlice('allProducts');
    
    const selectedProductData = allProducts.filter(p => selectedProducts.has(p.id));
    
    // Load detailed print area information
    const printAreaPromises = selectedProductData.map(async (product) => {
      try {
        let normalizedAreas = [];
        let providerName = product.provider || 'unknown';
        let providersList = [];
        // Using OAuth - no store ID headers needed
        const headers = {};

        if (product.provider === 'printful') {
          // Try v1 product (has print_files) first
          let v1Product = null;
          try {
            v1Product = await this.api.getPrintfulProductV1(product.originalId, { headers });
          } catch (_) {}

          normalizedAreas = this.normalizePrintAreas(v1Product, 'printful');
          providerName = 'Printful';
          providersList = ['Printful'];

          // Fallback to printfiles endpoint if needed
          if (!Array.isArray(normalizedAreas) || normalizedAreas.length === 0) {
            let printfiles = null;
            try {
              printfiles = await this.api.getPrintfilesV1(product.originalId, { headers });
            } catch (_) {}
            normalizedAreas = this.normalizePrintfulPrintAreasFromPrintfiles(printfiles);
          }
        } else if (product.provider === 'printify') {
          const detailedProduct = await this.api.getPrintifyProduct(product.originalId);
          normalizedAreas = this.normalizePrintAreas(detailedProduct, 'printify');
          providerName = 'Printify';
          providersList = this.extractPrintifyProvidersInfo(detailedProduct);
        }
        
        return {
          productId: product.id,
          printAreas: normalizedAreas,
          providerName,
          providersList
        };
      } catch (error) {
        console.error(`Failed to load print areas for ${product.id}:`, error);
        return {
          productId: product.id,
          printAreas: [],
          providerName: product.provider || 'unknown',
          providersList: []
        };
      }
    });
    
    const printAreaResults = await Promise.all(printAreaPromises);
    
    // Update state with print areas
    const currentPrintAreas = new Map(this.state.getStateSlice('printAreas'));
    
    printAreaResults.forEach(({ productId, printAreas, providerName, providersList }) => {
      if (!currentPrintAreas.has(productId)) {
        currentPrintAreas.set(productId, {
          positions: new Set(),
          areas: new Map(),
          providerName: providerName || 'unknown',
          providersList: Array.isArray(providersList) ? providersList : []
        });
      }
      
      const productPrintAreas = currentPrintAreas.get(productId);
      printAreas.forEach(area => {
        productPrintAreas.areas.set(area.id, area);
      });
    });
    
    this.state.updateState({ printAreas: currentPrintAreas });
  }
  
  /**
   * Toggle print area selection
   */
  togglePrintArea(productId, areaId, isSelected) {
    const printAreas = new Map(this.state.getStateSlice('printAreas'));
    
    if (!printAreas.has(productId)) {
      printAreas.set(productId, {
        positions: new Set(),
        areas: new Map()
      });
    }
    
    const productPrintAreas = printAreas.get(productId);
    
    if (isSelected) {
      productPrintAreas.positions.add(areaId);
    } else {
      productPrintAreas.positions.delete(areaId);
    }
    
    this.state.updateState({ printAreas });
    this.updateStepCompletion();
  }
  
  /**
   * Select all print areas for a product
   */
  selectAllPrintAreas(productId) {
    const printAreas = new Map(this.state.getStateSlice('printAreas'));
    
    if (!printAreas.has(productId)) return;
    
    const productPrintAreas = printAreas.get(productId);
    const allAreaIds = Array.from(productPrintAreas.areas.keys());
    
    productPrintAreas.positions = new Set(allAreaIds);
    
    this.state.updateState({ printAreas });
    this.updateStepCompletion();
  }
  
  /**
   * Clear all print areas for a product
   */
  clearAllPrintAreas(productId) {
    const printAreas = new Map(this.state.getStateSlice('printAreas'));
    
    if (!printAreas.has(productId)) return;
    
    const productPrintAreas = printAreas.get(productId);
    productPrintAreas.positions.clear();
    
    this.state.updateState({ printAreas });
    this.updateStepCompletion();
  }
  
  /**
   * Normalize print areas from different providers
   */
  normalizePrintAreas(productData, provider) {
    if (provider === 'printful') {
      return this.normalizePrintfulPrintAreas(productData);
    } else if (provider === 'printify') {
      return this.normalizePrintifyPrintAreas(productData);
    }
    return [];
  }
  
  /**
   * Normalize Printful print areas
   */
  normalizePrintfulPrintAreas(productData) {
    try {
      const printFiles = (productData && (
        productData.print_files ||
        productData.result?.print_files ||
        productData.data?.print_files
      )) || [];
      
      return printFiles.map(file => ({
        id: file.id,
        name: file.title || file.type,
        type: file.type,
        width: Math.round(Number(file.width) || 0),
        height: Math.round(Number(file.height) || 0),
        dpi: file.dpi || 300,
        position: file.placement || 'front',
        technique: file.technique || 'sublimation',
        preview: file.preview_url || file.image_url || file.image || file.mockup_url || file.thumbnail_url || '',
        requirements: {
          minWidth: Math.round(Number(file.width) || 0),
          minHeight: Math.round(Number(file.height) || 0),
          maxColors: file.max_colors || null,
          fileTypes: ['PNG', 'JPG', 'PDF']
        }
      }));
    } catch (_) {
      return [];
    }
  }

  /**
   * Normalize Printful print areas from printfiles endpoint (v1)
   * Deduplicates by placement and uses safe defaults when dimensions are not provided
   */
  normalizePrintfulPrintAreasFromPrintfiles(printfilesData) {
    try {
      if (!printfilesData) return [];
      const variantPrintf = (
        printfilesData.variant_printfiles ||
        printfilesData.result?.variant_printfiles ||
        printfilesData.data?.variant_printfiles ||
        []
      );

      // Some responses include a top-level "printfiles" list
      const topPrintf = (
        printfilesData.printfiles ||
        printfilesData.result?.printfiles ||
        printfilesData.data?.printfiles ||
        []
      );

      const byPlacement = new Map();

      const addArea = (placement, info = {}) => {
        const key = String(placement || info.type || 'front').toLowerCase();
        if (byPlacement.has(key)) return;
        const width = Math.round(Number(info.width || info.printfile_width) || 0);
        const height = Math.round(Number(info.height || info.printfile_height) || 0);
        const dpi = info.dpi || 300;
        // Use reasonable defaults instead of 3000px
        const defaultWidth = width || 1200;
        const defaultHeight = height || 1200;
        byPlacement.set(key, {
          id: key,
          name: info.title || key,
          type: info.type || key,
          width: defaultWidth,
          height: defaultHeight,
          dpi,
          position: key,
          technique: info.technique || 'sublimation',
          preview: info.preview_url || info.image_url || info.image || info.mockup_url || info.thumbnail_url || '',
          requirements: {
            minWidth: defaultWidth,
            minHeight: defaultHeight,
            maxColors: info.max_colors || null,
            fileTypes: ['PNG', 'JPG', 'PDF']
          }
        });
      };

      // From nested variant_printfiles -> possibly contains `placement` or nested `printfiles`
      (Array.isArray(variantPrintf) ? variantPrintf : []).forEach(v => {
        if (v && (v.placement || v.type)) {
          addArea(v.placement || v.type, v);
        }
        const nested = Array.isArray(v?.printfiles) ? v.printfiles : [];
        nested.forEach(pf => addArea(pf.placement || pf.type, pf));
      });

      // From top-level printfiles
      (Array.isArray(topPrintf) ? topPrintf : []).forEach(pf => addArea(pf.placement || pf.type, pf));

      return Array.from(byPlacement.values());
    } catch (_) {
      return [];
    }
  }
  
  /**
   * Normalize Printify print areas
   */
  normalizePrintifyPrintAreas(productData) {
    const printAreas = productData.print_areas || [];
    
    return printAreas.map(area => ({
      id: area.variant_ids?.[0] || area.id,
      name: area.name,
      type: area.type || 'print_area',
      width: Math.round(Number(area.width) || 0),
      height: Math.round(Number(area.height) || 0),
      dpi: area.dpi || 300,
      position: area.position || 'front',
      technique: area.technique || 'dtg',
      preview: area.background || '',
      requirements: {
        minWidth: Math.round(Number(area.width) || 0),
        minHeight: Math.round(Number(area.height) || 0),
        maxColors: null,
        fileTypes: ['PNG', 'JPG']
      }
    }));
  }
  
  /**
   * Render print areas interface
   */
  renderPrintAreas() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const allProducts = this.state.getStateSlice('allProducts');
    const printAreas = this.state.getStateSlice('printAreas');
    
    const selectedProductData = allProducts.filter(p => selectedProducts.has(p.id));
    const container = document.getElementById('print-areas-container');
    
    if (!container) return;
    
    const providerHeader = this.renderProviderHeader();
    const productsHtml = selectedProductData.map(product => 
      this.renderProductPrintAreas(product, printAreas.get(product.id))
    ).join('');
    
    container.innerHTML = providerHeader + productsHtml;

    // After initial render, populate requirement prompts (e.g., stitch_color)
    selectedProductData.forEach(p => this.ensureProductOptionsUI(p));
  }
  
  /**
   * Render print areas for a single product
   */
  renderProductPrintAreas(product, productPrintAreas) {
    if (!productPrintAreas || !productPrintAreas.areas.size) {
      return `
        <div class="product-print-areas" data-product-id="${product.id}">
          <div class="product-header">
            <img src="${product.image}" alt="${product.title}">
            <div class="product-info">
              <h3>${product.title}</h3>
              <p>${product.category}</p>
            </div>
          </div>
          <div class="print-areas-loading">
            <p>Loading print areas...</p>
          </div>
        </div>
      `;
    }
    
    const areas = Array.from(productPrintAreas.areas.values());
    const selectedPositions = productPrintAreas.positions;
    
    return `
      <div class="product-print-areas" data-product-id="${product.id}">
        <div class="product-header">
          <img src="${product.image}" alt="${product.title}">
          <div class="product-info">
            <h3>${product.title}</h3>
            <p>${product.category}</p>
            <div class="small text-muted">Provider: ${productPrintAreas?.providerName || 'Printful'}</div>
          </div>
          <div class="product-actions">
            <button type="button" 
                    class="btn btn-sm btn-outline-primary" 
                    data-action="select-all-print-areas" 
                    data-product-id="${product.id}">
              Select All
            </button>
            <button type="button" 
                    class="btn btn-sm btn-outline-secondary" 
                    data-action="clear-all-print-areas" 
                    data-product-id="${product.id}">
              Clear All
            </button>
          </div>
        </div>
        
        <div class="print-areas-grid">
          ${areas.map(area => this.renderPrintAreaCard(area, selectedPositions.has(area.id), product.id, product.image)).join('')}
        </div>
        
        <div class="selection-summary">
          <span class="selected-count">${selectedPositions.size}</span> of 
          <span class="total-count">${areas.length}</span> print areas selected
        </div>

        <div class="product-requirements mt-2" id="product-options-${product.id}">
          <!-- Populated asynchronously if required (e.g., stitch_color for embroidery) -->
        </div>
      </div>
    `;
  }
  
  /**
   * Render individual print area card
   */
  renderPrintAreaCard(area, isSelected, productId, productImage) {
    const fallbackPreview = productImage || 'https://via.placeholder.com/600x600?text=Preview';
    const previewUrl = area.preview && typeof area.preview === 'string' && area.preview.trim() ? area.preview : fallbackPreview;
    return `
      <div class="print-area-card ${isSelected ? 'selected' : ''}" data-area-id="${area.id}">
        <div class="print-area-preview">
          <img src="${previewUrl}" alt="${area.name}" onerror="this.onerror=null;this.src='https://via.placeholder.com/600x600?text=Preview'">
          <div class="print-area-overlay">
            <label class="print-area-checkbox">
              <input type="checkbox" 
                     ${isSelected ? 'checked' : ''} 
                     data-action="toggle-print-area" 
                     data-product-id="${productId}"
                     data-area-id="${area.id}">
              <span class="checkmark"></span>
            </label>
          </div>
        </div>
        
        <div class="print-area-info">
          <h4 class="print-area-name">${area.name}</h4>
          <p class="print-area-position">${area.position}</p>
          <div class="print-area-specs">
            <span class="dimensions">${Math.round(area.width)} × ${Math.round(area.height)}px</span>
            <span class="dpi">${area.dpi} DPI</span>
            <span class="technique">${area.technique || 'Sublimation'}</span>
          </div>
          
          <div class="requirements">
            <small class="text-muted">
              Min: ${area.requirements.minWidth} × ${area.requirements.minHeight}px<br>
              Formats: ${area.requirements.fileTypes.join(', ')}
            </small>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Update step completion status
   */
  updateStepCompletion() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const printAreas = this.state.getStateSlice('printAreas');
    const completedSteps = new Set(this.state.getStateSlice('completedSteps'));
    
    // Check if all selected products have at least one print area selected
    let allProductsHavePrintAreas = true;
    
    for (const productId of selectedProducts) {
      const productPrintAreas = printAreas.get(productId);
      if (!productPrintAreas || productPrintAreas.positions.size === 0) {
        allProductsHavePrintAreas = false;
        break;
      }
    }
    
    if (allProductsHavePrintAreas && selectedProducts.size > 0) {
      completedSteps.add(2);
      completedSteps.add(3); // Enable next step
    } else {
      completedSteps.delete(3);
      completedSteps.delete(4);
    }
    
    this.state.updateState({ completedSteps });
  }
  
  /**
   * Initialize event listeners
   */
  initializeEventListeners() {
    // Listen for state changes
    this.state.subscribe('change:selectedProducts', () => {
      this.initialize();
    });
    
    this.state.subscribe('change:printAreas', () => {
      this.renderPrintAreas();
    });
    
    // Listen for UI events via event delegation
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-action="toggle-print-area"]')) {
        const productId = e.target.dataset.productId;
        const areaId = e.target.dataset.areaId;
        this.togglePrintArea(productId, areaId, e.target.checked);
      }
      
      if (e.target.matches('[data-action="select-all-print-areas"]')) {
        const productId = e.target.dataset.productId;
        this.selectAllPrintAreas(productId);
      }
      
      if (e.target.matches('[data-action="clear-all-print-areas"]')) {
        const productId = e.target.dataset.productId;
        this.clearAllPrintAreas(productId);
      }
    });

    // Provider header controls
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (!t) return;
      if (t.matches && t.matches('[data-action="set-selling-region"]')) {
        const v = String(t.value || 'north_america');
        this.setSellingRegion(v);
      }

      // Capture product option selections (e.g., stitch_color)
      if (t.matches && t.matches('[data-action="set-product-option"]')) {
        const productId = t.getAttribute('data-product-id');
        const name = t.getAttribute('data-option-name');
        const value = String(t.value || '').trim();
        if (productId && name) {
          const current = this.state.getStateSlice('productOptions') || {};
          if (!current[productId]) current[productId] = [];
          const arr = Array.isArray(current[productId]) ? current[productId] : [];
          const idx = arr.findIndex(o => String(o?.name) === String(name));
          if (idx >= 0) arr[idx] = { name, value }; else arr.push({ name, value });
          current[productId] = arr;
          this.state.updateState({ productOptions: current });
        }
      }
    });
  }

  // Provider settings persistence
  getSellingRegion() {
    try { return localStorage.getItem('pf_selling_region') || 'north_america'; } catch(_) { return 'north_america'; }
  }
  setSellingRegion(v) {
    try { localStorage.setItem('pf_selling_region', v || 'north_america'); } catch(_) {}
  }

  /**
   * Populate required product options UI for a product (e.g., stitch_color for embroidery)
   * Infers technique by reading mockup-styles. OAuth-safe, no store headers.
   */
  async ensureProductOptionsUI(product) {
    try {
      const productId = product.id;
      const originalId = product.originalId || product.catalog_product_id || productId;
      if (!originalId) return;
      const container = document.getElementById(`product-options-${productId}`);
      if (!container) return;

      const endpoint = `/v2/catalog-products/${encodeURIComponent(String(originalId))}/mockup-styles?default_mockup_styles=true`;
      let stylesRes = null;
      try {
        stylesRes = await this.api.printful(endpoint, { method: 'GET', headers: { 'X-PF-Language': 'en' } });
      } catch(_) {}
      const arr = this.arrayFromResponse(stylesRes);
      const techniques = new Set();
      (Array.isArray(arr) ? arr : []).forEach(item => {
        const list = Array.isArray(item?.mockup_styles) ? item.mockup_styles : [item];
        list.forEach(s => {
          const tech = (s?.technique || s?.technique_key || s?.techniqueKey || '').toString().toLowerCase();
          if (tech) techniques.add(tech);
        });
      });

      const requiresStitch = Array.from(techniques).some(t => t.includes('embroidery'));
      const requiresKnitwear = Array.from(techniques).some(t => t.includes('knit'));

      if (!requiresStitch && !requiresKnitwear) {
        container.innerHTML = '';
        return;
      }

      // Gather saved values
      const current = this.state.getStateSlice('productOptions') || {};
      const savedArr = Array.isArray(current[productId]) ? current[productId] : [];
      const getSaved = (name, fallback) => {
        const it = savedArr.find(o => String(o?.name) === String(name));
        return it ? String(it.value) : fallback;
      };
      const stitchVal = getSaved('stitch_color', 'black');
      const borderVal = getSaved('custom_border_color', '#000000');

      // Build UI blocks
      const blocks = [];
      if (requiresStitch) {
        blocks.push(`
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <div class="fw-semibold">Embroidery</div>
            <div class="small text-muted">Select stitch color for embroidery mockups.</div>
            <div class="ms-auto d-flex align-items-center gap-2">
              <label class="form-label mb-0 small">Stitch color</label>
              <select class="form-select form-select-sm" data-action="set-product-option" data-product-id="${productId}" data-option-name="stitch_color">
                <option value="white" ${stitchVal === 'white' ? 'selected' : ''}>White</option>
                <option value="black" ${stitchVal === 'black' ? 'selected' : ''}>Black</option>
                <option value="clear" ${stitchVal === 'clear' ? 'selected' : ''}>Clear</option>
              </select>
            </div>
          </div>
        `);
      }
      if (requiresKnitwear) {
        blocks.push(`
          <div class="d-flex align-items-center gap-2 flex-wrap mt-2">
            <div class="fw-semibold">Knitwear</div>
            <div class="small text-muted">Optional: set custom border color.</div>
            <div class="ms-auto d-flex align-items-center gap-2">
              <label class="form-label mb-0 small">Border color</label>
              <input type="color" class="form-control form-control-color form-control-sm" value="${borderVal}"
                     data-action="set-product-option"
                     data-product-id="${productId}"
                     data-option-name="custom_border_color" />
            </div>
          </div>
        `);
      }

      container.innerHTML = `
        <div class="alert alert-warning py-2 px-3">
          ${blocks.join('')}
        </div>
      `;
    } catch (e) {
      // Fail silently; requirement prompts are best-effort
    }
  }

  // Printify providers placeholder (extend when needed)
  extractPrintifyProvidersInfo(detailedProduct) {
    try {
      const providers = new Set();
      const variants = Array.isArray(detailedProduct?.variants) ? detailedProduct.variants : [];
      variants.forEach(v => { if (v?.provider) providers.add(v.provider); });
      return Array.from(providers);
    } catch(_) { return []; }
  }
  
  /**
   * Get selected print areas data
   */
  getSelectedPrintAreasData() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const printAreas = this.state.getStateSlice('printAreas');
    
    const result = new Map();
    
    for (const productId of selectedProducts) {
      const productPrintAreas = printAreas.get(productId);
      if (productPrintAreas && productPrintAreas.positions.size > 0) {
        const selectedAreas = [];
        
        for (const areaId of productPrintAreas.positions) {
          const area = productPrintAreas.areas.get(areaId);
          if (area) {
            selectedAreas.push(area);
          }
        }
        
        result.set(productId, selectedAreas);
      }
    }
    
    return result;
  }
  
  /**
   * Validate print area requirements
   */
  validatePrintAreaRequirements(productId, areaId, imageData) {
    const printAreas = this.state.getStateSlice('printAreas');
    const productPrintAreas = printAreas.get(productId);
    
    if (!productPrintAreas) return { valid: false, errors: ['Product not found'] };
    
    const area = productPrintAreas.areas.get(areaId);
    if (!area) return { valid: false, errors: ['Print area not found'] };
    
    const errors = [];
    
    // Check dimensions
    if (imageData.width < area.requirements.minWidth) {
      errors.push(`Image width (${imageData.width}px) is less than required minimum (${area.requirements.minWidth}px)`);
    }
    
    if (imageData.height < area.requirements.minHeight) {
      errors.push(`Image height (${imageData.height}px) is less than required minimum (${area.requirements.minHeight}px)`);
    }
    
    // Check file type
    if (!area.requirements.fileTypes.includes(imageData.format?.toUpperCase())) {
      errors.push(`File format (${imageData.format}) not supported. Allowed formats: ${area.requirements.fileTypes.join(', ')}`);
    }
    
    // Check DPI if available
    if (imageData.dpi && imageData.dpi < area.dpi) {
      errors.push(`Image DPI (${imageData.dpi}) is less than recommended (${area.dpi})`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings: errors.length === 0 ? [] : ['Image may not print at optimal quality']
    };
  }
  
  /**
   * Cleanup
   */
  destroy() {
    // Event listeners are handled by event delegation, no cleanup needed
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrintAreasController;
} else if (typeof window !== 'undefined') {
  window.PrintAreasController = PrintAreasController;
}

export default PrintAreasController;

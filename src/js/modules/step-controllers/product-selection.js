/**
 * Product Selection Step Controller
 * Handles all logic for Step 1: Product Selection
 */

class ProductSelectionController {
  constructor(stateManager, apiClient) {
    this.state = stateManager;
    this.api = apiClient;
    this.debounceTimers = new Map();
    
    this.initializeEventListeners();
  }
  
  /**
   * Initialize the product selection step
   */
  async initialize() {
    try {
      this.state.updateState({ loading: true });
      
      // Load products from both APIs
      const region = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_selling_region')) || 'united_states';
      const storeId = (typeof localStorage !== 'undefined' && localStorage.getItem('pf_store_id')) || '';
      // OAuth account-level: do not send X-PF-Store-Id for v2 endpoints
      const headers = {};
      const [printfulProducts, printifyProducts] = await Promise.all([
        // Printful v2 catalog with DSR (Default Selling Region) filter applied
        this.api.getCatalogProductsV2({ limit: 50, page: 1, selling_region: region }, { headers }).catch(() => ([])),
        this.api.getPrintifyProducts().catch(() => ({ data: [] }))
      ]);
      
      // Normalize and combine products
      const normalizedPrintful = this.normalizePrintfulProducts(this.arrayFromResponse(printfulProducts));
      const regionAbbr = this.regionAbbr(region);
      const printfulWithRegion = normalizedPrintful.map(p => ({
        ...p,
        sellingRegion: region,
        sellingRegionAbbr: regionAbbr
      }));
      const allProducts = [
        ...printfulWithRegion,
        ...this.normalizePrintifyProducts(printifyProducts.data || [])
      ];
      
      this.state.updateState({
        allProducts,
        filteredProducts: allProducts,
        loading: false
      });
      
      this.renderProducts();
      
    } catch (error) {
      console.error('Failed to initialize product selection:', error);
      this.state.updateState({
        loading: false,
        error: 'Failed to load products. Please try again.'
      });
    }
  }
  
  /**
   * Toggle product selection
   */
  toggleProduct(productId, isSelected) {
    const selectedProducts = new Set(this.state.getStateSlice('selectedProducts'));
    
    if (isSelected) {
      selectedProducts.add(productId);
    } else {
      selectedProducts.delete(productId);
      
      // Clean up related state
      const printAreas = new Map(this.state.getStateSlice('printAreas'));
      const selectedImages = new Map(this.state.getStateSlice('selectedImages'));
      
      printAreas.delete(productId);
      selectedImages.delete(productId);
      
      this.state.updateState({
        selectedProducts,
        printAreas,
        selectedImages
      });
      return;
    }
    
    this.state.updateState({ selectedProducts });
    this.updateStepCompletion();
  }
  
  /**
   * Apply filters to products
   */
  applyFilters(filters) {
    // Debounce filter application
    this.debounce('applyFilters', () => {
      const allProducts = this.state.getStateSlice('allProducts');
      const filteredProducts = this.filterProducts(allProducts, filters);
      
      this.state.updateState({
        productFilters: filters,
        filteredProducts
      });
      
      this.renderProducts();
    }, 300);
  }
  
  /**
   * Search products
   */
  searchProducts(searchTerm) {
    const currentFilters = this.state.getStateSlice('productFilters');
    const newFilters = { ...currentFilters, searchTerm };
    this.applyFilters(newFilters);
  }
  
  /**
   * Filter products based on criteria
   */
  filterProducts(products, filters) {
    return products.filter(product => {
      // Category filter
      if (filters.category && product.category !== filters.category) {
        return false;
      }
      
      // Type filter
      if (filters.type && product.type !== filters.type) {
        return false;
      }
      
      // Brand filter
      if (filters.brand && product.brand !== filters.brand) {
        return false;
      }
      
      // Search term filter
      if (filters.searchTerm) {
        const searchLower = filters.searchTerm.toLowerCase();
        const searchableText = [
          product.title,
          product.description,
          product.category,
          product.type,
          product.brand
        ].join(' ').toLowerCase();
        
        if (!searchableText.includes(searchLower)) {
          return false;
        }
      }
      
      return true;
    });
  }
  
  /**
   * Get available filter options
   */
  getFilterOptions() {
    const allProducts = this.state.getStateSlice('allProducts');
    
    const categories = [...new Set(allProducts.map(p => p.category))].filter(Boolean).sort();
    const types = [...new Set(allProducts.map(p => p.type))].filter(Boolean).sort();
    const brands = [...new Set(allProducts.map(p => p.brand))].filter(Boolean).sort();
    
    return { categories, types, brands };
  }
  
  /**
   * Normalize Printful products
   */
  normalizePrintfulProducts(products) {
    return products.map(product => {
      const id = product.id ?? product.catalog_product_id ?? product.product_id;
      const title = product.title ?? product.name ?? product.product_name ?? 'Untitled';
      const description = product.description || '';
      const type = product.type || product.product_type || product.category || 'Unknown';
      const image = product.image || product.preview_image || (Array.isArray(product.images) ? product.images[0] : '') || '';
      const variants = product.variants || product.variant_count || [];
      const printAreas = product.print_areas || [];
      return {
        id: `printful_${id}`,
        originalId: id,
        provider: 'printful',
        title,
        description,
        category: type,
        type,
        brand: 'Printful',
        image,
        variants: Array.isArray(variants) ? variants : (typeof variants === 'number' ? new Array(variants).fill({}) : []),
        printAreas
      };
    });
  }
  
  /**
   * Normalize Printify products
   */
  normalizePrintifyProducts(products) {
    return products.map(product => ({
      id: `printify_${product.id}`,
      originalId: product.id,
      provider: 'printify',
      title: product.title,
      description: product.description || '',
      category: product.brand || 'Unknown',
      type: product.model || 'Unknown',
      brand: product.brand || 'Printify',
      image: product.image || '',
      variants: product.variants || [],
      printAreas: product.print_areas || []
    }));
  }
  
  /**
   * Render products in the UI
   */
  renderProducts() {
    const filteredProducts = this.state.getStateSlice('filteredProducts');
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const container = document.getElementById('products-container');
    
    if (!container) return;
    
    // Use virtual scrolling for large product lists
    if (filteredProducts.length > 100) {
      this.renderVirtualizedProducts(container, filteredProducts, selectedProducts);
    } else {
      this.renderStandardProducts(container, filteredProducts, selectedProducts);
    }
  }
  
  /**
   * Render products with virtual scrolling
   */
  renderVirtualizedProducts(container, products, selectedProducts) {
    // Implement virtual scrolling for performance
    const itemHeight = 200; // Height of each product card
    const containerHeight = container.clientHeight;
    const visibleItems = Math.ceil(containerHeight / itemHeight) + 2; // Buffer
    
    let scrollTop = container.scrollTop || 0;
    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = Math.min(startIndex + visibleItems, products.length);
    
    const visibleProducts = products.slice(startIndex, endIndex);
    
    container.innerHTML = `
      <div style="height: ${products.length * itemHeight}px; position: relative;">
        <div style="position: absolute; top: ${startIndex * itemHeight}px; width: 100%;">
          ${visibleProducts.map(product => this.renderProductCard(product, selectedProducts.has(product.id))).join('')}
        </div>
      </div>
    `;
  }
  
  /**
   * Render products normally
   */
  renderStandardProducts(container, products, selectedProducts) {
    container.innerHTML = products.map(product => 
      this.renderProductCard(product, selectedProducts.has(product.id))
    ).join('');
  }
  
  /**
   * Render individual product card
   */
  renderProductCard(product, isSelected) {
    const regionBadge = product.sellingRegionAbbr ? `
      <div class="region-badge" title="${product.sellingRegion}">
        ${product.sellingRegionAbbr}
      </div>
    ` : '';
    return `
      <div class="product-card ${isSelected ? 'selected' : ''}" data-product-id="${product.id}">
        <div class="product-image">
          <img src="${product.image}" alt="${product.title}" loading="lazy">
          ${regionBadge}
          <div class="product-overlay">
            <label class="product-checkbox">
              <input type="checkbox" 
                     ${isSelected ? 'checked' : ''} 
                     data-action="toggle-product" 
                     data-product-id="${product.id}">
              <span class="checkmark"></span>
            </label>
          </div>
        </div>
        <div class="product-info">
          <h3 class="product-title">${product.title}</h3>
          <p class="product-category">${product.category}</p>
          <p class="product-brand">${product.brand}</p>
          <div class="product-meta">
            <span class="variant-count">${product.variants.length} variants</span>
            <span class="print-area-count">${product.printAreas.length} print areas</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Map selling region code to short badge label
   */
  regionAbbr(code) {
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
  }
  
  /**
   * Update step completion status
   */
  updateStepCompletion() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const completedSteps = new Set(this.state.getStateSlice('completedSteps'));
    
    if (selectedProducts.size > 0) {
      completedSteps.add(1);
      completedSteps.add(2); // Enable next step
    } else {
      completedSteps.delete(2);
      completedSteps.delete(3);
      completedSteps.delete(4);
    }
    
    this.state.updateState({ completedSteps });
  }
  
  /**
   * Change region and reload products
   */
  async changeRegion(newRegion) {
    try {
      // Save to localStorage
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('pf_selling_region', newRegion);
      }
      
      // Reload products with new region
      await this.initialize();
    } catch (error) {
      console.error('Error changing region:', error);
    }
  }
  
  /**
   * Initialize event listeners
   */
  initializeEventListeners() {
    // Listen for state changes
    this.state.subscribe('change:filteredProducts', () => {
      this.renderProducts();
    });
    
    this.state.subscribe('change:selectedProducts', () => {
      this.renderProducts();
    });
    
    // Listen for UI events via event delegation
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-action="toggle-product"]')) {
        const productId = e.target.dataset.productId;
        this.toggleProduct(productId, e.target.checked);
      }
    });
    
    document.addEventListener('input', (e) => {
      if (e.target.matches('[data-action="search-products"]')) {
        this.searchProducts(e.target.value);
      }
      
      if (e.target.matches('[data-action="filter-products"]')) {
        const filterType = e.target.dataset.filterType;
        const currentFilters = this.state.getStateSlice('productFilters');
        const newFilters = { ...currentFilters, [filterType]: e.target.value };
        this.applyFilters(newFilters);
      }
      
      if (e.target.matches('[data-action="change-region"]')) {
        this.changeRegion(e.target.value);
      }
    });
    
    // Virtual scrolling listener
    document.addEventListener('scroll', (e) => {
      const t = e && e.target;
      // Guard: some scroll events originate from Document/Window which don't have .matches
      if (t && typeof t.matches === 'function' && t.matches('#products-container')) {
        this.debounce('virtualScroll', () => {
          this.renderProducts();
        }, 16); // ~60fps
      }
    });
  }
  
  /**
   * Debounce utility
   */
  debounce(key, func, delay) {
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key));
    }
    
    const timer = setTimeout(() => {
      func();
      this.debounceTimers.delete(key);
    }, delay);
    
    this.debounceTimers.set(key, timer);
  }
  
  /**
   * Helper: extract array from various API response envelopes
   */
  arrayFromResponse(res) {
    if (Array.isArray(res)) return res;
    if (res && typeof res === 'object') {
      if (Array.isArray(res.data)) return res.data;
      if (Array.isArray(res.result)) return res.result;
      if (Array.isArray(res.items)) return res.items;
    }
    return [];
  }
  
  /**
   * Get selected products data
   */
  getSelectedProductsData() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const allProducts = this.state.getStateSlice('allProducts');
    
    return allProducts.filter(product => selectedProducts.has(product.id));
  }
  
  /**
   * Cleanup
   */
  destroy() {
    // Clear debounce timers
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    
    // Remove event listeners would be handled by the main app
  }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ProductSelectionController;
} else if (typeof window !== 'undefined') {
  window.ProductSelectionController = ProductSelectionController;
}

export default ProductSelectionController;

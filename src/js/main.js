/**
 * Main Application Controller
 * Orchestrates the modular architecture and initializes all components
 */

import StateManager from './modules/state-manager.js';
import ApiClient from './modules/api-client.js';
import ProductSelectionController from './modules/step-controllers/product-selection.js';
import PrintAreasController from './modules/step-controllers/print-areas.js';
import DesignGenerationController from './modules/step-controllers/design-generation.js';

class BulklyApp {
  constructor() {
    this.state = StateManager;
    this.api = ApiClient;
    this.controllers = new Map();
    this.initialized = false;
    
    this.initializeEventListeners();
  }
  
  /**
   * Initialize the application
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      console.log('Initializing Bulkly App...');
      
      // Initialize step controllers
      this.controllers.set('productSelection', new ProductSelectionController(this.state, this.api));
      this.controllers.set('printAreas', new PrintAreasController(this.state, this.api));
      this.controllers.set('design', new DesignGenerationController(this.state, this.api));
      
      // Initialize UI components
      this.initializeStepNavigation();
      this.initializeFilterOptions();
      
      // Load initial data
      await this.loadInitialData();
      
      // Set initial step
      this.showStep(1);
      
      this.initialized = true;
      console.log('Bulkly App initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize Bulkly App:', error);
      this.state.updateState({
        error: 'Failed to initialize application. Please refresh the page.'
      });
    }
  }
  
  /**
   * Load initial data
   */
  async loadInitialData() {
    // Initialize product selection step
    const productController = this.controllers.get('productSelection');
    if (productController) {
      await productController.initialize();
    }
  }
  
  /**
   * Show specific step
   */
  showStep(stepNumber) {
    const validSteps = [1, 2, 3, 4];
    if (!validSteps.includes(stepNumber)) return;
    
    // Update state
    this.state.updateState({ currentStep: stepNumber });
    
    // Update UI
    this.updateStepNavigation(stepNumber);
    this.showStepContent(stepNumber);
    
    // Initialize step-specific controllers
    this.initializeStepController(stepNumber);
  }
  
  /**
   * Initialize step-specific controller
   */
  async initializeStepController(stepNumber) {
    switch (stepNumber) {
      case 1:
        const productController = this.controllers.get('productSelection');
        if (productController) {
          await productController.initialize();
        }
        break;
        
      case 2:
        const printAreasController = this.controllers.get('printAreas');
        if (printAreasController) {
          await printAreasController.initialize();
        }
        break;
        
      case 3:
        const designController = this.controllers.get('design');
        if (designController) {
          await designController.initialize();
        }
        break;
        
      case 4:
        // Pricing and publishing controller will be initialized here
        break;
    }
  }
  
  /**
   * Update step navigation UI
   */
  updateStepNavigation(currentStep) {
    const completedSteps = this.state.getStateSlice('completedSteps');
    
    // Update step indicators
    for (let i = 1; i <= 4; i++) {
      const stepElement = document.querySelector(`[data-step="${i}"]`);
      if (stepElement) {
        stepElement.classList.remove('active', 'completed');
        
        if (i === currentStep) {
          stepElement.classList.add('active');
        } else if (completedSteps.has(i)) {
          stepElement.classList.add('completed');
        }
        
        // Enable/disable step based on completion
        const isEnabled = i === 1 || completedSteps.has(i - 1);
        stepElement.classList.toggle('disabled', !isEnabled);
      }
    }
    
    // Update navigation buttons
    this.updateNavigationButtons(currentStep, completedSteps);
  }
  
  /**
   * Update navigation buttons
   */
  updateNavigationButtons(currentStep, completedSteps) {
    const prevButton = document.getElementById('prev-step');
    const nextButton = document.getElementById('next-step');
    
    if (prevButton) {
      prevButton.disabled = currentStep === 1;
    }
    
    if (nextButton) {
      const canProceed = completedSteps.has(currentStep);
      nextButton.disabled = currentStep === 4 || !canProceed;
      nextButton.textContent = currentStep === 4 ? 'Complete' : 'Next Step';
    }
  }
  
  /**
   * Show step content
   */
  showStepContent(stepNumber) {
    // Hide all step contents
    document.querySelectorAll('.step-content').forEach(content => {
      content.style.display = 'none';
    });
    
    // Show current step content
    const currentContent = document.getElementById(`step-${stepNumber}-content`);
    if (currentContent) {
      currentContent.style.display = 'block';
    }
    
    // Update step title
    const stepTitles = {
      1: 'Select Products',
      2: 'Choose Print Areas',
      3: 'Generate Designs',
      4: 'Pricing & Publishing'
    };
    
    const titleElement = document.getElementById('current-step-title');
    if (titleElement) {
      titleElement.textContent = stepTitles[stepNumber] || 'Unknown Step';
    }
  }
  
  /**
   * Initialize step navigation
   */
  initializeStepNavigation() {
    // Step navigation clicks
    document.addEventListener('click', (e) => {
      if (e.target.matches('[data-step]')) {
        const stepNumber = parseInt(e.target.dataset.step);
        const completedSteps = this.state.getStateSlice('completedSteps');
        
        // Only allow navigation to completed steps or the next available step
        if (stepNumber === 1 || completedSteps.has(stepNumber - 1)) {
          this.showStep(stepNumber);
        }
      }
      
      // Previous/Next buttons
      if (e.target.matches('#prev-step')) {
        const currentStep = this.state.getStateSlice('currentStep');
        if (currentStep > 1) {
          this.showStep(currentStep - 1);
        }
      }
      
      if (e.target.matches('#next-step')) {
        const currentStep = this.state.getStateSlice('currentStep');
        const completedSteps = this.state.getStateSlice('completedSteps');
        
        if (currentStep < 4 && completedSteps.has(currentStep)) {
          this.showStep(currentStep + 1);
        } else if (currentStep === 4 && completedSteps.has(4)) {
          this.completeWorkflow();
        }
      }
    });
  }
  
  /**
   * Initialize filter options
   */
  initializeFilterOptions() {
    const productController = this.controllers.get('productSelection');
    if (!productController) return;
    
    const filterOptions = productController.getFilterOptions();
    
    // Populate category filter
    const categorySelect = document.getElementById('category-filter');
    if (categorySelect && filterOptions.categories) {
      categorySelect.innerHTML = '<option value="">All Categories</option>' +
        filterOptions.categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
    }
    
    // Populate type filter
    const typeSelect = document.getElementById('type-filter');
    if (typeSelect && filterOptions.types) {
      typeSelect.innerHTML = '<option value="">All Types</option>' +
        filterOptions.types.map(type => `<option value="${type}">${type}</option>`).join('');
    }
    
    // Populate brand filter
    const brandSelect = document.getElementById('brand-filter');
    if (brandSelect && filterOptions.brands) {
      brandSelect.innerHTML = '<option value="">All Brands</option>' +
        filterOptions.brands.map(brand => `<option value="${brand}">${brand}</option>`).join('');
    }
  }
  
  /**
   * Complete the workflow
   */
  async completeWorkflow() {
    try {
      this.state.updateState({ loading: true });
      
      // Get all the data from controllers
      const selectedProducts = this.controllers.get('productSelection')?.getSelectedProductsData() || [];
      const printAreas = this.controllers.get('printAreas')?.getSelectedPrintAreasData() || new Map();
      
      console.log('Workflow completed with:', {
        products: selectedProducts.length,
        printAreas: printAreas.size
      });
      
      // Here you would typically save the configuration or proceed to publishing
      this.state.updateState({
        loading: false,
        error: null
      });
      
      // Show success message
      this.showSuccessMessage('Workflow completed successfully!');
      
    } catch (error) {
      console.error('Failed to complete workflow:', error);
      this.state.updateState({
        loading: false,
        error: 'Failed to complete workflow. Please try again.'
      });
    }
  }
  
  /**
   * Show success message
   */
  showSuccessMessage(message) {
    // Create and show success notification
    const notification = document.createElement('div');
    notification.className = 'alert alert-success';
    notification.textContent = message;
    
    const container = document.querySelector('.container') || document.body;
    container.insertBefore(notification, container.firstChild);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
      notification.remove();
    }, 5000);
  }
  
  /**
   * Initialize global event listeners
   */
  initializeEventListeners() {
    // Listen for state changes
    this.state.subscribe('change:currentStep', (data) => {
      this.updateStepNavigation(data.value);
    });
    
    this.state.subscribe('change:completedSteps', () => {
      const currentStep = this.state.getStateSlice('currentStep');
      this.updateStepNavigation(currentStep);
    });
    
    this.state.subscribe('change:loading', (data) => {
      this.updateLoadingState(data.value);
    });
    
    this.state.subscribe('change:error', (data) => {
      this.updateErrorState(data.value);
    });
    
    // Global error handling
    window.addEventListener('error', (e) => {
      console.error('Global error:', e.error);
      this.state.updateState({
        error: 'An unexpected error occurred. Please refresh the page.'
      });
    });
    
    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (e) => {
      console.error('Unhandled promise rejection:', e.reason);
      this.state.updateState({
        error: 'An unexpected error occurred. Please refresh the page.'
      });
    });
  }
  
  /**
   * Update loading state UI
   */
  updateLoadingState(isLoading) {
    const loadingElements = document.querySelectorAll('.loading-indicator');
    const mainContent = document.querySelector('.main-content');
    
    loadingElements.forEach(el => {
      el.style.display = isLoading ? 'block' : 'none';
    });
    
    if (mainContent) {
      mainContent.style.opacity = isLoading ? '0.5' : '1';
      mainContent.style.pointerEvents = isLoading ? 'none' : 'auto';
    }
  }
  
  /**
   * Update error state UI
   */
  updateErrorState(error) {
    const errorContainer = document.getElementById('error-container');
    
    if (errorContainer) {
      if (error) {
        errorContainer.innerHTML = `
          <div class="alert alert-danger">
            <strong>Error:</strong> ${error}
            <button type="button" class="btn-close" onclick="this.parentElement.style.display='none'"></button>
          </div>
        `;
        errorContainer.style.display = 'block';
      } else {
        errorContainer.style.display = 'none';
      }
    }
  }
  
  /**
   * Get application instance
   */
  static getInstance() {
    if (!BulklyApp.instance) {
      BulklyApp.instance = new BulklyApp();
    }
    return BulklyApp.instance;
  }
  
  /**
   * Cleanup
   */
  destroy() {
    // Cleanup controllers
    this.controllers.forEach(controller => {
      if (controller.destroy) {
        controller.destroy();
      }
    });
    
    this.controllers.clear();
    this.initialized = false;
    
    // Reset state
    if (this.state && typeof this.state.resetState === 'function') {
      this.state.resetState();
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const app = BulklyApp.getInstance();
  app.initialize();
});

// Export for global access
window.BulklyApp = BulklyApp;

export default BulklyApp;

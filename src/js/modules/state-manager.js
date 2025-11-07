/**
 * Centralized State Management Module
 * Handles all application state with proper encapsulation
 */

class StateManager {
  constructor() {
    this.state = {
      // Core workflow state
      currentStep: 1,
      completedSteps: new Set([1]),
      
      // Product selection state
      selectedProducts: new Set(),
      allProducts: [],
      filteredProducts: [],
      productFilters: {
        category: '',
        type: '',
        brand: '',
        searchTerm: ''
      },
      
      // Print areas state
      printAreas: new Map(), // productId -> { positions: Set, areas: Map }
      
      // Design generation state
      selectedImages: new Map(), // productId -> imageData
      generatedDesigns: new Map(), // productId -> designData
      generationProgress: new Map(), // productId -> progress%
      
      // Pricing and publishing state
      createdProducts: [],
      publishingProgress: new Map(), // productId -> status
      
      // Step 5 (optional) fine-tune overrides per product/placement
      // Structure: step5Overrides[productId][placement] = { x, y, scale, rotation }
      step5Overrides: {},
      // New granular structure for per-placement overrides without breaking existing usage
      // Structure: step5PlacementOverrides[productId][placement] = { x, y, scale, rotation }
      step5PlacementOverrides: {},
      
      // Step 2 (requirements) selected product-level options per product
      // Structure: productOptions[productId] = [{ name: string, value: string }]
      productOptions: {},
      
      // UI state
      loading: false,
      error: null,
      modals: {
        imageSelection: false,
        designPreview: false,
        pricing: false
      },
      
      // API state
      rateLimits: {
        printful: { remaining: 120, resetTime: null },
        printify: { remaining: 100, resetTime: null }
      }
    };
    
    this.listeners = new Map(); // event -> Set of callbacks
    this.history = []; // State history for undo/redo
    this.maxHistorySize = 50;
  }
  
  /**
   * Get current state (immutable copy)
   */
  getState() {
    return this.deepClone(this.state);
  }
  
  /**
   * Get specific state slice
   */
  getStateSlice(path) {
    const keys = path.split('.');
    let current = this.state;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }
    
    return this.deepClone(current);
  }
  
  /**
   * Update state with validation and history tracking
   */
  updateState(updates, options = {}) {
    const { skipHistory = false, validate = true } = options;
    
    // Validate updates if enabled
    if (validate && !this.validateStateUpdate(updates)) {
      throw new Error('Invalid state update');
    }
    
    // Save current state to history
    if (!skipHistory) {
      this.saveToHistory();
    }
    
    // Apply updates
    const previousState = this.deepClone(this.state);
    this.mergeDeep(this.state, updates);
    
    // Emit change events
    this.emitStateChange(previousState, this.state, updates);
  }
  
  /**
   * Reset state to initial values
   */
  resetState() {
    const initialState = new StateManager().state;
    this.updateState(initialState, { skipHistory: false });
  }
  
  /**
   * Subscribe to state changes
   */
  subscribe(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    
    // Return unsubscribe function
    return () => {
      const eventListeners = this.listeners.get(event);
      if (eventListeners) {
        eventListeners.delete(callback);
        if (eventListeners.size === 0) {
          this.listeners.delete(event);
        }
      }
    };
  }
  
  /**
   * Unsubscribe from state changes
   */
  unsubscribe(event, callback) {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(callback);
    }
  }
  
  /**
   * Emit state change events
   */
  emitStateChange(previousState, currentState, updates) {
    const changeEvent = {
      previousState: this.deepClone(previousState),
      currentState: this.deepClone(currentState),
      updates: this.deepClone(updates),
      timestamp: Date.now()
    };
    
    // Emit general state change
    this.emit('stateChange', changeEvent);
    
    // Emit specific property changes
    this.emitSpecificChanges(updates, changeEvent);
  }
  
  /**
   * Emit specific property change events
   */
  emitSpecificChanges(updates, changeEvent) {
    const flatUpdates = this.flattenObject(updates);
    
    for (const [path, value] of Object.entries(flatUpdates)) {
      this.emit(`change:${path}`, { ...changeEvent, path, value });
    }
  }
  
  /**
   * Emit event to listeners
   */
  emit(event, data) {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in state listener for ${event}:`, error);
        }
      });
    }
  }
  
  /**
   * Save current state to history
   */
  saveToHistory() {
    this.history.push(this.deepClone(this.state));
    
    // Limit history size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }
  
  /**
   * Undo last state change
   */
  undo() {
    if (this.history.length > 0) {
      const previousState = this.history.pop();
      this.state = previousState;
      this.emit('stateChange', {
        previousState: this.state,
        currentState: this.state,
        updates: {},
        timestamp: Date.now(),
        isUndo: true
      });
    }
  }
  
  /**
   * Validate state updates
   */
  validateStateUpdate(updates) {
    // Add validation rules as needed
    if (updates.currentStep && (updates.currentStep < 1 || updates.currentStep > 4)) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Deep clone object
   */
  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (obj instanceof Date) return new Date(obj);
    if (obj instanceof Set) return new Set([...obj]);
    if (obj instanceof Map) return new Map([...obj]);
    if (Array.isArray(obj)) return obj.map(item => this.deepClone(item));
    
    const cloned = {};
    for (const [key, value] of Object.entries(obj)) {
      cloned[key] = this.deepClone(value);
    }
    return cloned;
  }
  
  /**
   * Deep merge objects
   */
  mergeDeep(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && 
          !(value instanceof Set) && !(value instanceof Map) && !(value instanceof Date)) {
        if (!target[key] || typeof target[key] !== 'object') {
          target[key] = {};
        }
        this.mergeDeep(target[key], value);
      } else {
        target[key] = this.deepClone(value);
      }
    }
  }
  
  /**
   * Flatten nested object for change detection
   */
  flattenObject(obj, prefix = '') {
    const flattened = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      
      if (value && typeof value === 'object' && !Array.isArray(value) && 
          !(value instanceof Set) && !(value instanceof Map) && !(value instanceof Date)) {
        Object.assign(flattened, this.flattenObject(value, newKey));
      } else {
        flattened[newKey] = value;
      }
    }
    
    return flattened;
  }
}

// Create singleton instance
const stateManager = new StateManager();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = stateManager;
} else if (typeof window !== 'undefined') {
  window.StateManager = stateManager;
}

export default stateManager;

# Bulkly - Modular Architecture Documentation

## Overview

Bulkly has been restructured from a monolithic 2000+ line HTML file into a clean, modular architecture that follows modern web development best practices. This restructuring addresses the core issues of maintainability, scalability, and performance.

## Architecture Overview

### Before: Monolithic Structure
- Single 2000+ line HTML file with embedded JavaScript
- Global scope pollution with scattered variables
- Inline event handlers mixing business logic with markup
- No separation of concerns
- Performance issues with large DOM manipulations

### After: Modular Architecture
```
src/
├── js/
│   ├── modules/
│   │   ├── state-manager.js          # Centralized state management
│   │   ├── api-client.js             # API abstraction layer
│   │   └── step-controllers/         # Step-specific business logic
│   │       ├── product-selection.js  # Step 1: Product selection logic
│   │       └── print-areas.js        # Step 2: Print area selection logic
│   └── main.js                       # Application orchestrator
├── css/
│   └── styles.css                    # Modular CSS styles
└── index.html                        # Clean HTML structure
```

## Key Modules

### 1. State Manager (`state-manager.js`)
**Purpose**: Centralized state management with immutable updates and event system

**Features**:
- Immutable state updates with validation
- Event-driven architecture with pub/sub pattern
- State history for undo/redo functionality
- Deep cloning and merging utilities
- Change detection and specific event emission

**Usage**:
```javascript
// Subscribe to state changes
StateManager.subscribe('change:selectedProducts', (data) => {
  console.log('Products changed:', data.value);
});

// Update state
StateManager.updateState({
  selectedProducts: new Set(['product1', 'product2'])
});

// Get state slice
const products = StateManager.getStateSlice('selectedProducts');
```

### 2. API Client (`api-client.js`)
**Purpose**: Centralized API communication with rate limiting and caching

**Features**:
- Integration with existing Netlify functions
- Rate limiting with exponential backoff
- Response caching with TTL
- Error handling and retry logic
- Batch request capabilities

**Integrated Functions**:
- `generate-content.js`: AI content generation using Google Gemini
- `generate-mockup-gallery.js`: Printful mockup generation

**Usage**:
```javascript
// Generate AI content
const content = await ApiClient.generateCompleteProductContent(
  'Modern minimalist design for coffee lovers',
  { style: 'modern', audience: 'coffee enthusiasts' }
);

// Generate mockup gallery
const mockups = await ApiClient.generateMockupGallery({
  catalog_product_id: '123',
  placement_files: [{ placement: 'front', image_url: 'url' }],
  count: 10
});
```

### 3. Step Controllers
**Purpose**: Encapsulate business logic for each workflow step

#### Product Selection Controller (`product-selection.js`)
- Product loading from Printful/Printify APIs
- Filtering and searching with debouncing
- Virtual scrolling for performance
- Product normalization across providers

#### Print Areas Controller (`print-areas.js`)
- Print area loading and validation
- Requirements checking for images
- Bulk selection operations
- Provider-specific normalization

### 4. Main Application Controller (`main.js`)
**Purpose**: Application orchestration and initialization

**Features**:
- Module initialization and coordination
- Step navigation management
- Global event handling
- Error boundary implementation
- Loading state management

## State Structure

```javascript
{
  // Core workflow state
  currentStep: 1,
  completedSteps: new Set([1]),
  
  // Product selection state
  selectedProducts: new Set(),
  allProducts: [],
  filteredProducts: [],
  productFilters: { category: '', type: '', brand: '', searchTerm: '' },
  
  // Print areas state
  printAreas: new Map(), // productId -> { positions: Set, areas: Map }
  
  // Design generation state
  selectedImages: new Map(),
  generatedDesigns: new Map(),
  generationProgress: new Map(),
  
  // Pricing and publishing state
  createdProducts: [],
  publishingProgress: new Map(),
  
  // UI state
  loading: false,
  error: null,
  modals: { imageSelection: false, designPreview: false, pricing: false },
  
  // API state
  rateLimits: {
    printful: { remaining: 120, resetTime: null },
    printify: { remaining: 100, resetTime: null }
  }
}
```

## Event System

The application uses a pub/sub event system for loose coupling:

```javascript
// General state changes
StateManager.subscribe('stateChange', (changeEvent) => {
  // Handle any state change
});

// Specific property changes
StateManager.subscribe('change:selectedProducts', (data) => {
  // Handle product selection changes
});

// Path-based changes
StateManager.subscribe('change:productFilters.category', (data) => {
  // Handle category filter changes
});
```

## Performance Optimizations

### 1. Virtual Scrolling
For large product lists (>100 items), virtual scrolling is automatically enabled:
- Only renders visible items plus buffer
- Reduces DOM nodes and memory usage
- Smooth scrolling performance

### 2. Debouncing
User interactions are debounced to prevent excessive API calls:
- Search input: 300ms debounce
- Filter changes: 300ms debounce
- Scroll events: 16ms debounce (~60fps)

### 3. Caching
API responses are cached with TTL:
- Default cache TTL: 5 minutes
- Automatic cache invalidation
- Pattern-based cache clearing

### 4. Rate Limiting
Built-in rate limiting prevents API quota exhaustion:
- Printful: 120 requests/minute
- Printify: 100 requests/minute
- Exponential backoff on rate limit hits

## Error Handling

### 1. Global Error Boundary
Catches and handles uncaught errors:
```javascript
window.addEventListener('error', (e) => {
  StateManager.updateState({
    error: 'An unexpected error occurred. Please refresh the page.'
  });
});
```

### 2. API Error Handling
Robust error handling with retries:
- Automatic retries for transient errors
- Exponential backoff for rate limits
- Fallback responses for critical failures

### 3. Validation
Input validation at multiple levels:
- State update validation
- API request validation
- UI input validation

## Integration with Existing Infrastructure

The modular architecture seamlessly integrates with existing Netlify functions:

### Generate Content Function
- Supports multiple content types: title, description, tags, key-features, materials
- Robust fallback mechanisms
- Rate limiting and retry logic
- Structured JSON responses

### Generate Mockup Gallery Function
- Diverse mockup style selection
- Polling for task completion
- Error handling and timeouts
- Deduplication of results

## Development Workflow

### 1. Adding New Features
1. Identify the appropriate module (state, API, controller)
2. Add new state properties if needed
3. Implement business logic in controllers
4. Add UI components and event handlers
5. Test integration

### 2. Debugging
- Use browser dev tools to inspect state
- Monitor network requests in API client
- Check console for detailed logging
- Use state history for issue reproduction

### 3. Testing
- Unit test individual modules
- Integration test step controllers
- End-to-end test complete workflows
- Performance test with large datasets

## Migration Benefits

### 1. Maintainability
- Clear separation of concerns
- Modular code organization
- Easier debugging and testing
- Reduced code duplication

### 2. Scalability
- Easy to add new features
- Modular loading capabilities
- Performance optimizations
- Memory management

### 3. Developer Experience
- Better code organization
- Improved debugging tools
- Cleaner git diffs
- Easier onboarding

### 4. Performance
- Virtual scrolling for large lists
- Debounced user interactions
- Efficient state management
- Optimized API usage

## Future Enhancements

### 1. Code Splitting
- Lazy load step controllers
- Dynamic imports for large modules
- Progressive loading of features

### 2. Web Workers
- Move heavy computations to workers
- Background data processing
- Non-blocking UI updates

### 3. Service Worker
- Offline functionality
- Background sync
- Push notifications

### 4. Testing Framework
- Unit tests for all modules
- Integration tests for workflows
- Performance benchmarks
- Automated testing pipeline

## Conclusion

The modular architecture transformation addresses all the original issues:
- ✅ Eliminated monolithic structure
- ✅ Removed global scope pollution
- ✅ Replaced inline event handlers
- ✅ Implemented proper module system
- ✅ Added performance optimizations

The new architecture is maintainable, scalable, and performant while preserving all existing functionality and integrating seamlessly with the existing Netlify functions infrastructure.

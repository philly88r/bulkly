/**
 * Design Generation Step Controller
 * Wires Step 3 UI to Netlify generate-content function and summarizes selections
 */

class DesignGenerationController {
  constructor(stateManager, apiClient) {
    this.state = stateManager;
    this.api = apiClient;
    this.bound = false;
  }

  async initialize() {
    // Only bind DOM events once
    if (!this.bound) {
      this.bindDom();
      this.bound = true;
    }
    this.updateProjectSummary();
  }

  bindDom() {
    const genBtn = document.getElementById('generateBtn');
    if (genBtn) {
      genBtn.addEventListener('click', () => this.handleGenerate());
    }
  }

  getSelectedProducts() {
    const selectedProducts = this.state.getStateSlice('selectedProducts');
    const allProducts = this.state.getStateSlice('allProducts');
    return allProducts.filter(p => selectedProducts.has(p.id));
  }

  getSelectedPrintAreas() {
    return this.state.getStateSlice('printAreas');
  }

  updateProjectSummary() {
    const container = document.getElementById('projectSummary');
    if (!container) return;
    const products = this.getSelectedProducts();
    const printAreas = this.getSelectedPrintAreas();

    const items = products.map(p => {
      const pa = printAreas.get(p.id);
      const count = pa ? pa.positions.size : 0;
      let areaInfo = '';
      if (pa && pa.positions.size > 0) {
        const firstId = Array.from(pa.positions)[0];
        const area = pa.areas.get(firstId);
        if (area) {
          const width = Math.round(Number(area.width) || 0);
          const height = Math.round(Number(area.height) || 0);
          const technique = area.technique || 'sublimation';
          areaInfo = ` — <span class="text-muted">${width}×${height}px, ${technique}</span>`;
        }
      }
      return `<li>${this.escape(p.title)}${areaInfo || ` — <span class="text-muted">${count} print area${count===1?'':'s'}</span>`}</li>`;
    }).join('');

    container.innerHTML = `
      <div>
        <div class="mb-2">Selected products: <strong>${products.length}</strong></div>
        <ul class="mb-0">${items || '<li class="text-muted">No products selected</li>'}</ul>
      </div>
    `;
  }

  async handleGenerate() {
    const promptEl = document.getElementById('bulkPrompt');
    const styleEl = document.getElementById('bulkStyle');
    const colorsEl = document.getElementById('bulkColors');
    const audienceEl = document.getElementById('bulkAudience');
    const genBtn = document.getElementById('generateBtn');

    const prompt = (promptEl?.value || '').trim();
    const style = styleEl?.value || '';
    const colors = colorsEl?.value || '';
    const audience = audienceEl?.value || '';

    if (!prompt) {
      alert('Enter a prompt to generate product content');
      return;
    }

    try {
      if (genBtn) {
        genBtn.disabled = true;
        genBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Generating...';
      }

      const products = this.getSelectedProducts();
      const results = new Map();

      // Generate content per product (serial to avoid rate limits)
      for (const p of products) {
        const productInfo = [{ title: p.title, brand: p.brand, id: p.originalId }];
        const res = await this.api.generateContent(prompt, {
          contentType: 'product-content',
          style,
          colors,
          audience,
          productId: p.originalId,
          productInfo
        });
        // Now also generate images via Netlify generate-image
        const selectedPrintAreas = this.getSelectedPrintAreas();
        const pa = selectedPrintAreas.get(p.id);
        // Pick a representative size: must come from Step 2 print area; abort if missing
        let size = null;
        let technique = 'sublimation';
        if (pa && pa.positions && pa.positions.size > 0) {
          const firstId = Array.from(pa.positions)[0];
          const area = pa.areas.get(firstId);
          if (area && Number(area.width) && Number(area.height)) {
            const width = Math.round(Number(area.width));
            const height = Math.round(Number(area.height));
            // Clamp to reasonable image generation sizes
            const clampedWidth = Math.min(Math.max(width, 512), 2048);
            const clampedHeight = Math.min(Math.max(height, 512), 2048);
            size = `${clampedWidth}x${clampedHeight}`;
            technique = area.technique || 'sublimation';
          }
        }
        if (!size) {
          console.error('generate-image aborted: missing Step 2 print area size');
          alert('Select a product print area in Step 2 (with known dimensions) before generating images.');
          continue;
        }
        const numImages = 1; // keep light; can make this configurable
        const imgPayload = {
          prompt,
          numImages,
          size,
          style,
          colors,
          audience,
          targetSize: size
        };
        let imagesResp = null;
        try {
          imagesResp = await this.api.netlify('generate-image', imgPayload);
        } catch (e) {
          console.warn('generate-image failed for product', p.id, e?.message || e);
        }
        results.set(p.id, { ...res, images: imagesResp?.images || [] });
      }

      // Save to state
      const newMap = new Map(this.state.getStateSlice('generatedDesigns'));
      results.forEach((val, key) => newMap.set(key, val));
      this.state.updateState({ generatedDesigns: newMap });

      // Render simple results list
      this.renderGenerated(results);

      // Mark step as completed to proceed
      const completed = new Set(this.state.getStateSlice('completedSteps'));
      completed.add(3);
      this.state.updateState({ completedSteps: completed });

    } catch (e) {
      console.error('Failed to generate content:', e);
      alert('Generate failed: ' + (e?.message || e));
    } finally {
      if (genBtn) {
        genBtn.disabled = false;
        genBtn.innerHTML = '<i class="bi bi-magic"></i> Generate Designs';
      }
    }
  }

  renderGenerated(resultsMap) {
    const card = document.getElementById('generatedImagesCard');
    const container = document.getElementById('generatedImagesContainer');
    if (!card || !container) return;

    const products = this.getSelectedProducts();
    const rows = products.map(p => {
      const r = resultsMap.get(p.id) || {};
      const title = this.escape(r.title || '');
      const desc = this.escape(r.description || '');
      const tags = Array.isArray(r.tags) ? r.tags.join(', ') : '';
      const kf = Array.isArray(r.key_features) ? r.key_features.map(this.escape).map(x=>`<li>${x}</li>`).join('') : '';
      const mats = Array.isArray(r.materials) ? r.materials.map(this.escape).map(x=>`<li>${x}</li>`).join('') : '';
      const imgs = Array.isArray(r.images) ? r.images : [];
      const imgsHtml = imgs.length
        ? `<div class="row g-2 mt-2">${imgs.map(img => `<div class="col-auto"><img src="${this.escape(img.url)}" alt="generated" style="width:140px;height:auto;border-radius:6px" onerror="this.style.display='none'"/></div>`).join('')}</div>`
        : '<div class="text-muted">No images generated.</div>';
      return `
        <div class="card mb-3">
          <div class="card-body">
            <h5 class="card-title">${this.escape(p.title)}</h5>
            <div class="mb-2"><strong>Title:</strong> ${title || '<span class="text-muted">n/a</span>'}</div>
            <div class="mb-2"><strong>Description:</strong><br><pre class="small mb-0" style="white-space:pre-wrap;">${desc}</pre></div>
            <div class="mb-2"><strong>Tags:</strong> ${this.escape(tags)}</div>
            <div class="row g-3">
              <div class="col-md-6">
                <div class="fw-bold small mb-1">Key Features</div>
                <ul class="small mb-0">${kf}</ul>
              </div>
              <div class="col-md-6">
                <div class="fw-bold small mb-1">Materials</div>
                <ul class="small mb-0">${mats}</ul>
              </div>
            </div>
            <div class="mt-3">
              <div class="fw-bold small mb-1">Generated Images</div>
              ${imgsHtml}
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = rows || '<div class="text-muted">No content yet.</div>';
    card.style.display = 'block';
  }

  escape(s) {
    try {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    } catch(_) { return ''; }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DesignGenerationController;
} else if (typeof window !== 'undefined') {
  window.DesignGenerationController = DesignGenerationController;
}

export default DesignGenerationController;

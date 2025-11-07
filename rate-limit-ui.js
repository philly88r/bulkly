// Rate limiting UI notifications for Printful API
// Printful allows only 2 mockup requests per minute

function showRateLimitNotification(totalProducts) {
  const estimatedMinutes = Math.ceil((totalProducts - 1) * 0.5); // 30s between requests
  
  const notification = document.createElement('div');
  notification.id = 'rateLimitNotification';
  notification.className = 'alert alert-warning position-fixed';
  notification.style.cssText = `
    top: 20px;
    right: 20px;
    z-index: 9999;
    max-width: 400px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  `;
  
  notification.innerHTML = `
    <div class="d-flex align-items-start">
      <i class="bi bi-clock-history me-2 mt-1"></i>
      <div class="flex-grow-1">
        <h6 class="alert-heading mb-2">⚠️ Rate Limited Processing</h6>
        <p class="mb-2">
          <strong>Printful allows only 2 mockup requests per minute.</strong><br>
          Processing ${totalProducts} products will take approximately <strong>${estimatedMinutes} minutes</strong>.
        </p>
        <div class="progress mb-2" style="height: 8px;">
          <div id="rateLimitProgress" class="progress-bar bg-warning" role="progressbar" style="width: 0%"></div>
        </div>
        <small class="text-muted">
          <i class="bi bi-lightbulb"></i> You can minimize this browser tab and come back later. 
          Processing will continue in the background.
        </small>
        <div id="rateLimitStatus" class="mt-2 small">
          <span class="badge bg-secondary">Starting...</span>
        </div>
      </div>
      <button type="button" class="btn-close btn-close-sm ms-2" onclick="minimizeRateLimitNotification()"></button>
    </div>
  `;
  
  document.body.appendChild(notification);
}

function updateRateLimitProgress(completed, total) {
  const progress = document.getElementById('rateLimitProgress');
  const status = document.getElementById('rateLimitStatus');
  
  if (progress && status) {
    const percentage = Math.round((completed / total) * 100);
    progress.style.width = percentage + '%';
    
    const remaining = total - completed;
    const eta = Math.ceil(remaining * 0.5); // 30s per remaining product
    
    status.innerHTML = `
      <span class="badge bg-primary">${completed}/${total} completed</span>
      <span class="badge bg-info">${eta}min remaining</span>
    `;
  }
}

function updateBulkMockupProgress(groupCompleted, totalGroups, productsInGroup) {
  const progress = document.getElementById('rateLimitProgress');
  const status = document.getElementById('rateLimitStatus');
  
  if (progress && status) {
    const percentage = Math.round((groupCompleted / totalGroups) * 100);
    progress.style.width = percentage + '%';
    
    const remaining = totalGroups - groupCompleted;
    const eta = Math.ceil(remaining * 0.5); // 30s per remaining group
    
    status.innerHTML = `
      <span class="badge bg-success">Design Group ${groupCompleted}/${totalGroups}</span>
      <span class="badge bg-primary">${productsInGroup} products</span>
      <span class="badge bg-info">${eta}min remaining</span>
    `;
  }
}

function minimizeRateLimitNotification() {
  const notification = document.getElementById('rateLimitNotification');
  if (notification) {
    notification.style.cssText += `
      width: 300px;
      height: 60px;
      overflow: hidden;
      transition: all 0.3s ease;
    `;
    notification.innerHTML = `
      <div class="d-flex align-items-center">
        <i class="bi bi-clock-history me-2"></i>
        <div class="flex-grow-1">
          <small><strong>Processing products...</strong></small>
          <div class="progress mt-1" style="height: 4px;">
            <div id="rateLimitProgress" class="progress-bar bg-warning" role="progressbar"></div>
          </div>
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary" onclick="expandRateLimitNotification()">
          <i class="bi bi-arrows-expand"></i>
        </button>
      </div>
    `;
  }
}

function expandRateLimitNotification() {
  const notification = document.getElementById('rateLimitNotification');
  if (notification) {
    location.reload(); // Simple way to restore full notification
  }
}

function hideRateLimitNotification() {
  const notification = document.getElementById('rateLimitNotification');
  if (notification) {
    notification.remove();
  }
}

// Add 30-minute polling capability for long-running processes
function startLongPolling(taskId, maxDurationMinutes = 30) {
  const startTime = Date.now();
  const maxDuration = maxDurationMinutes * 60 * 1000;
  
  const poll = async () => {
    try {
      if (Date.now() - startTime > maxDuration) {
        console.log('[LONG-POLL] Timeout reached, stopping polling');
        return null;
      }
      
      // Poll task status (implement based on your API)
      const status = await checkTaskStatus(taskId);
      
      if (status.completed) {
        return status.result;
      }
      
      // Continue polling every 30 seconds
      setTimeout(poll, 30000);
      
    } catch (error) {
      console.error('[LONG-POLL] Error:', error);
      setTimeout(poll, 60000); // Retry after 1 minute on error
    }
  };
  
  return poll();
}

async function checkTaskStatus(taskId) {
  // Placeholder - implement based on your specific API endpoints
  return { completed: false, result: null };
}

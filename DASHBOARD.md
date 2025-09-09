# Dashboard Documentation

## Overview
The dashboard provides a comprehensive interface for managing your Printify products. It displays your subscription information, usage statistics, and allows you to view, filter, and manage your products.

## Features

### Authentication
- The dashboard requires authentication via JWT token
- If no valid token is found, you will be redirected to the login page
- Your Printify API key must be set in your account settings to access Printify data

### Subscription Information
- Displays your current subscription plan
- Shows remaining trial days
- Tracks product usage against your monthly limits
- Monitors AI generation usage

### Product Management
- **View Products**: All your Printify products are displayed in a grid layout
- **Filter Products**: Filter by status, shop, and other attributes
- **Search**: Search products by title or description
- **Publish**: Publish unpublished products directly from the dashboard
- **Create New Products**: Quickly navigate to the product creation workflow

### Error Handling
- Comprehensive error notifications for API failures
- Fallback images for products with missing images
- Graceful handling of authentication issues

## API Integration

The dashboard integrates with several backend functions:

1. **get-products.js**: Fetches products from Printify API
   - Authenticates with your stored Printify API key
   - Retrieves products from all your Printify shops
   - Returns consolidated product data

2. **get-subscription.js**: Retrieves subscription information
   - Shows plan details and usage statistics
   - Calculates remaining trial days

3. **publish-product.js**: Publishes products to your shop
   - Sends product to your connected sales channels
   - Updates product status in the dashboard

4. **create-product.js**: Creates new Printify products
   - Handles variant creation
   - Manages print areas and image placement
   - Sets pricing and product details

## Usage Guide

### Viewing Products
1. Log in to access the dashboard
2. Products are automatically loaded and displayed in the grid
3. Recent products appear in the sidebar

### Filtering and Searching
1. Use the search box to find specific products
2. Filter by status (published/unpublished)
3. Filter by shop if you have multiple shops

### Publishing Products
1. Find an unpublished product in the grid
2. Click the "Publish" button
3. The system will publish the product to your shop
4. A success notification will appear when complete

### Creating New Products
1. Click the "New Product" button in the header
2. You'll be redirected to the product creation workflow
3. Follow the guided steps to create your product

## Troubleshooting

### Products Not Loading
- Verify your Printify API key is correctly set
- Check browser console for specific error messages
- Ensure you have an active internet connection

### Publish Button Not Working
- Verify the product is not already published
- Check if your Printify shop is properly connected
- Look for error notifications that may explain the issue

### Images Not Displaying
- The system will automatically use fallback images
- Check if your Printify product has valid images
- Verify the image URLs in the browser console

## Technical Notes

- All API calls include proper error handling and logging
- The dashboard uses client-side filtering for performance
- Authentication is handled via JWT tokens
- Printify API keys are stored encrypted in the database

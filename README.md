# Printify Print-on-Demand Manager

A complete web application for managing Printify print-on-demand products with AI design generation capabilities.

## Features

- Connect to your Printify account via API
- Browse and select products from the Printify catalog
- Generate designs using AI (via fal.ai)
- Create products with custom designs
- Manage variants and pricing

## Deployment on Netlify

### Prerequisites

- A Netlify account
- A Printify account with API access
- (Optional) API keys for fal.ai, OpenAI, or Stability AI for design generation

### Deployment Steps

1. Fork or clone this repository
2. Set up environment variables in the Netlify dashboard:
   - `FAL_KEY`: Your fal.ai API key (recommended)
   - `OPENAI_API_KEY`: Your OpenAI API key (fallback)
   - `STABILITY_API_KEY`: Your Stability AI API key (fallback)
3. Deploy to Netlify using one of these methods:
   - Connect your GitHub repository to Netlify
   - Use the Netlify CLI: `netlify deploy --prod`
   - Drag and drop the folder to Netlify's dashboard

### Local Development

1. Clone the repository
2. Create a `.env` file based on `.env.example`
3. Install dependencies: `npm install`
4. Run locally: `netlify dev`

## Project Structure

- `index.html` - Main application frontend
- `netlify/functions/printify-proxy.js` - Serverless function for Printify API calls
- `netlify/functions/generate-image.js` - Serverless function for AI image generation
- `netlify.toml` - Netlify configuration
- `_redirects` - URL redirects for SPA routing

## API Integration

This application uses Netlify Functions to securely proxy requests to:

1. Printify API (https://api.printify.com/v1)
2. fal.ai API for image generation

## License

MIT

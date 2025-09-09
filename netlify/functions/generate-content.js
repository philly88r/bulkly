// AI Content Generation for Printify Product Details
// Handles title, description, tags, key features, and materials generation using Google Gemini API

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const fetch = require('node-fetch');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { prompt, contentType = 'product-content', style, colors, audience, productId, productInfo } = body;
    console.log('[generate-content] START');
    console.log('[generate-content] Parsed data - prompt:', prompt);
    console.log('[generate-content] Parsed data - contentType:', contentType);
    console.log('[generate-content] Parsed data - productId:', productId);

    if (!prompt || !contentType) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, error: 'Missing prompt or contentType' })
      };
    }

    if (!GEMINI_API_KEY) {
      console.log('ERROR: Gemini API key not configured');
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({ success: false, error: 'Gemini API key not configured' })
      };
    }

    // Build enhanced prompt
    let enhancedPrompt = prompt;
    if (style) enhancedPrompt += `, ${style} style`;
    if (colors) enhancedPrompt += `, ${colors} color palette`;
    if (audience) enhancedPrompt += `, designed for ${audience}`;
    if (productInfo && Array.isArray(productInfo) && productInfo.length > 0) {
      try {
        const product = productInfo[0];
        if (product.title) enhancedPrompt += ` for a ${product.title}`;
        if (product.brand) enhancedPrompt += ` by ${product.brand}`;
        console.log('[generate-content] Enhanced prompt with product info:', enhancedPrompt);
      } catch (e) { console.error('[generate-content] Error using product info:', e); }
    } else if (body.productId) {
      enhancedPrompt += ` for product ${body.productId}`;
    }

    let systemPrompt = '';
    let maxTokens = 2000;
    switch (contentType) {
      case 'title': systemPrompt = getSystemPromptForTitle(); maxTokens = 100; break;
      case 'description': systemPrompt = getSystemPromptForDescription(); maxTokens = 2200; break;
      case 'tags': systemPrompt = getSystemPromptForTags(); maxTokens = 200; break;
      case 'key-features': systemPrompt = getSystemPromptForKeyFeatures(); maxTokens = 1000; break;
      case 'materials': systemPrompt = getSystemPromptForMaterials(); maxTokens = 200; break;
      case 'product-content': systemPrompt = getSystemPromptForProductContent(); maxTokens = 3000; break; // lowered to avoid timeouts
      default:
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ success: false, error: 'Invalid contentType' })
        };
    }
    console.log('[generate-content] System prompt set for contentType:', contentType);
    console.log('[generate-content] Max tokens:', maxTokens);

    const fullPrompt = buildFullPrompt(systemPrompt, enhancedPrompt);
    const geminiPayload = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7,
        topP: 0.8,
        topK: 40,
        ...(contentType === 'product-content' ? { responseMimeType: 'application/json' } : {})
      }
    };
    try {
      console.log('[generate-content] Gemini payload prepared. Prompt length:', fullPrompt?.length || 0);
      // Avoid logging entire payload if very large; log keys only
      console.log('[generate-content] generationConfig:', JSON.stringify(geminiPayload.generationConfig));
    } catch {}
    // Try primary and backup models in order
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
    let data = null;
    let lastErr = null;
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        console.log('[generate-content] Calling model:', model);
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
          body: JSON.stringify(geminiPayload)
        });
        console.log('[generate-content] Model response status:', model, response.status);
        if (!response.ok) {
          const errorText = await response.text();
          console.warn('[generate-content] Model failed:', model, errorText?.slice(0,200));
          lastErr = new Error(`Gemini API error ${response.status}: ${errorText}`);
          continue;
        }
        const d = await response.json();
        if (d && Array.isArray(d.candidates) && d.candidates.length) {
          data = d;
          console.log('[generate-content] Model succeeded:', model);
          break;
        } else {
          console.warn('[generate-content] Model returned no candidates:', model);
          lastErr = new Error('No candidates');
        }
      } catch (e) {
        console.warn('[generate-content] Model threw exception:', model, e && (e.message||e));
        lastErr = e;
      }
    }
    if (!data) {
      if (contentType === 'product-content') {
        const fallback = buildFallbackProductContent(enhancedPrompt, productInfo);
        console.warn('[generate-content] All models failed; returning fallback payload');
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(fallback) };
      }
      throw new Error(`Gemini models failed: ${lastErr ? String(lastErr.message||lastErr) : 'unknown error'}`);
    }
    console.log('[generate-content] Gemini full response received.');
    // Robustly extract text from candidates
    let content = '';
    try {
      const parts = data.candidates?.[0]?.content?.parts || [];
      const texts = parts.map(p => typeof p?.text === 'string' ? p.text : '').filter(Boolean);
      content = texts.join('\n').trim();
      if (!content && typeof data.candidates?.[0]?.content === 'string') content = String(data.candidates[0].content).trim();
    } catch(_) {}
    if (!content) {
      // Last-ditch: look for any stringified JSON-like segment in the whole payload
      try {
        const raw = JSON.stringify(data);
        const m = raw.match(/\{\"title\"[\s\S]*?\}/);
        if (m && m[0]) content = m[0].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      } catch(_) {}
    }
    if (!content) {
      if (contentType === 'product-content') {
        const fallback = buildFallbackProductContent(enhancedPrompt, productInfo);
        console.warn('[generate-content] No content from Gemini; returning fallback payload');
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify(fallback)
        };
      }
      throw new Error('No content generated');
    }

    let responseData;
    try {
      responseData = await processGeneratedContent(content, contentType);
      responseData.tokens = data.usageMetadata?.totalTokenCount || 0;
    } catch (err) {
      if (contentType === 'product-content') {
        console.warn('[generate-content] Parsing failed, building fallback content:', err && err.message);
        responseData = buildFallbackProductContent(enhancedPrompt, productInfo);
      } else {
        throw new Error(`Failed to process ${contentType}: ${err.message}`);
      }
    }
    console.log('[generate-content] Returning success response:', JSON.stringify(responseData).slice(0, 500));
    // Return success payload
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(responseData)
    };

  } catch (error) {
    console.error('=== AI CONTENT GENERATION ERROR ===');
    console.error('[generate-content] Error message:', error.message);
    console.error('[generate-content] Error stack:', error.stack);
    const errorResponse = { success: false, error: error.message || 'Failed to generate content' };
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify(errorResponse)
    };
  }
};

// Build a resilient fallback payload matching the product-content shape
function buildFallbackProductContent(prompt, productInfo){
  try {
    const p = String(prompt||'').toLowerCase();
    const prodTitle = Array.isArray(productInfo) && productInfo[0]?.title ? String(productInfo[0].title) : 'Product';
    const brand = Array.isArray(productInfo) && productInfo[0]?.brand ? String(productInfo[0].brand) : '';
    const baseTitle = (p.split(/[\.\n]/)[0] || 'Custom Design').replace(/[^a-z0-9\s-]/gi,' ').trim();
    const title = `${capitalize(baseTitle).slice(0, 80)} - ${prodTitle.slice(0, 40)}${brand?` by ${brand}`:''}`.slice(0,140);
    const descIntro = capitalize(baseTitle) || 'Custom Design';
    const description = (
      `${descIntro} ${prodTitle} – thoughtfully crafted for everyday use.\n\n`+
      `This listing was auto-generated to keep your workflow moving while our AI writer is busy. `+
      `It includes clear benefits, care, and use cases so you can publish now and refine later.\n\n`+
      `Quality & Materials\n`+
      `• Durable construction and comfortable feel\n`+
      `• Reliable print with long-lasting colors\n`+
      `• Designed for frequent use\n\n`+
      `Perfect For\n`+
      `• Fans and gift giving\n`+
      `• Daily wear and everyday utility\n`+
      `• Personal expression and team spirit\n\n`+
      `Care\n`+
      `• Follow standard care instructions for longest life\n\n`+
      `Note: You can safely publish this and edit the content later.\n`
    ).slice(0, 2200);
    const words = (p.match(/[a-z0-9]+/gi) || []).map(w=>w.toLowerCase());
    const uniq = Array.from(new Set(words.filter(w=>w.length>2))).slice(0, 20);
    const toTag = (s)=>s.replace(/\s+/g,'-').slice(0,20);
    const tags = padTo13(uniq.map(toTag), ['custom', 'gift', 'unique', 'trending', 'quality', 'modern', 'classic', 'fan', 'logo', 'design', 'style', 'everyday', 'premium']);
    const key_featuresSeed = [
      'Premium quality materials ensure everyday durability and comfort.',
      'Crisp, vivid print keeps colors looking fresh over time.',
      'Thoughtfully designed for a flattering, comfortable fit.',
      'Versatile style pairs well with casual and active looks.',
      'Ideal for fans; makes a great gift for special occasions.',
      'Lightweight feel for ease and comfort throughout the day.',
      'Easy-care construction simplifies cleaning and maintenance.',
      'Crafted for long wear with attention to stitching and finish.',
      'Design theme showcases personality and sparks conversation.',
      'Comfort-forward design suitable for everyday use.',
      'Reliable print technology for consistent results.',
      'Ethically produced through trusted manufacturing partners.',
      'Backed by responsive support to ensure a great experience.'
    ];
    const key_features = key_featuresSeed.map(s=>s.slice(0,500));
    // Materials vary lightly by product name
    const lowerTitle = prodTitle.toLowerCase();
    let materialsBase = [];
    if (/towel/.test(lowerTitle)) materialsBase = ['cotton-terry','soft-microfiber','woven-edge','absorbent-fiber','quick-dry','colorfast-dye','stitched-hem','premium-weave','care-label','eco-ink','loop-finish','quality-thread','packaging'];
    else if (/hoodie|sweatshirt/.test(lowerTitle)) materialsBase = ['cotton-poly-blend','ring-spun-cotton','polyester-fleece','ribbed-knit','double-needle','dyed-fabric','drawstring','metal-grommet','kangaroo-pocket','care-label','premium-ink','sturdy-thread','packaging'];
    else if (/phone.*case/.test(lowerTitle)) materialsBase = ['polycarbonate-shell','tpu-liner','uv-ink','scratch-resistant','matte-coating','gloss-coating','precision-cut','button-coverage','camera-bezel','wireless-charge','shock-absorb','corner-protect','packaging'];
    else materialsBase = ['ring-spun-cotton','dtg-ink','quality-thread','pre-shrunk','soft-hand','breathable','care-label','eco-ink','colorfast','double-needle','stitched-hem','durable-fabric','packaging'];
    const materials = padTo13(materialsBase, ['material-a','material-b','material-c','material-d','material-e','material-f','material-g','material-h','material-i','material-j','material-k','material-l','material-m']);
    return { success: true, title, description, tags, key_features, materials, tokens: 0 };
  } catch (e) {
    // Absolute last resort minimal payload
    const safeTitle = 'Auto-Generated Product Title';
    const minimalTags = padTo13([], ['custom','gift','unique','trending','quality','modern','classic','fan','logo','design','style','everyday','premium']);
    const minimalArray = new Array(13).fill('Auto-generated');
    return { success: true, title: safeTitle, description: 'Auto-generated description.', tags: minimalTags, key_features: minimalArray, materials: minimalArray, tokens: 0 };
  }
}

function padTo13(arr, padPool){
  const out = Array.from(new Set(arr.filter(Boolean)));
  let i = 0;
  while (out.length < 13) {
    const next = padPool[i % padPool.length];
    const candidate = typeof next === 'string' ? next : String(next||'tag');
    if (!out.includes(candidate)) out.push(candidate);
    i++;
  }
  return out.slice(0,13);
}

function capitalize(s){ return String(s||'').replace(/^\s+|\s+$/g,'').replace(/\s+/g,' ').replace(/\b\w/g, c=>c.toUpperCase()); }
  function getSystemPromptForTitle() {
    return `You are an expert e-commerce copywriter specializing in product titles that rank well on Etsy and convert browsers into buyers.

Generate a compelling, SEO-optimized product title (max 140 characters) using the provided product details.

STRICT FORMAT REQUIREMENT:
"[Primary Keywords + Design Description] [Product Type] - [Brand] [Additional Benefits/Keywords]"

Examples:
"Vintage Floral Watercolor Art T-Shirt - MyBrand Cottagecore Fashion Gift"
"Minimalist Mountain Landscape Hoodie - EcoWear Sustainable Outdoor Apparel"
"Cute Cat Lover Coffee Mug - PetLife Ceramic Gift for Cat Mom"

Requirements:
- Start with primary SEO keywords that describe the design/theme
- Include the actual product type (T-Shirt, Hoodie, Mug, etc.)
- Include brand name unless it's "generic" or not provided
- Add benefit-focused keywords that buyers search for
- Use power words that create urgency/desire
- Optimize for both search algorithms and human psychology
- Stay within 140 character limit
- Make every word count for maximum impact

Return ONLY the title, no additional text or formatting.`;
}

function getSystemPromptForDescription() {
  return `You are a world-class e-commerce copywriter who creates product descriptions that rank #1 on Etsy and convert at 15%+ rates.

Write a compelling, SEO-optimized product description that reads naturally while incorporating strategic keywords for maximum search visibility.

CRITICAL SEO STRUCTURE:
- First 160 characters: Include primary keyword + main benefit + unique selling proposition (this becomes the meta description)
- Keyword density: 2-3% for primary keyword, natural integration of related terms
- Include 8-12 long-tail keyword phrases throughout
- Use semantic variations and LSI keywords
- Structure for featured snippets with questions/answers

CONTENT STRUCTURE:
**Opening Hook** (First 160 chars - crucial for SEO)
Start with benefit-driven statement including primary keywords

**Product Overview**
- What it is and why customers need it
- Key design elements and visual appeal
- Brand story integration (if brand provided)

**Quality & Materials**
- Detailed manufacturing specifications
- Fabric weight, feel, and durability details
- Production process and quality standards
- Care instructions for longevity

**Design Details**
- Vivid description of artwork/design
- Print placement and technique
- Color accuracy and vibrancy
- Size and fit information

**Perfect For**
- Multiple use cases and occasions
- Target audience benefits
- Gift-giving scenarios
- Lifestyle integration

**Why Choose Us**
- Unique selling propositions
- Customer satisfaction points
- Social proof elements

**Call to Action**
- Urgency and scarcity elements
- Clear next steps

TARGET LENGTH: 1800-2200 characters (longer descriptions rank better)
Use short paragraphs (2-3 sentences) for mobile readability.
Include natural keyword variations throughout.
Write for humans first, optimize for search second.

Return the description with proper line breaks using \\n for formatting.`;
}

function getSystemPromptForTags() {
  return `Generate EXACTLY 13 high-performing Etsy tags that maximize product discoverability and sales potential.

CRITICAL REQUIREMENTS:
- Generate exactly 13 tags - no more, no less
- Each tag MUST be 20 characters or less - this is non-negotiable
- No duplicate tags
- Use lowercase with hyphens instead of spaces
- Focus on buyer search intent, not just keywords

TAG STRATEGY (13 tags total):
1. Primary keyword tag (main product focus)
2-4. Long-tail buyer-intent phrases (what customers actually search)
5-7. Material/style specific tags (cotton-tshirt, ceramic-mug, etc.)
8-9. Occasion/use case tags (gift-for-mom, birthday-present)
10-11. Target audience tags (cat-lover, fitness-enthusiast)
12-13. Trending/seasonal tags (if applicable)

OPTIMIZATION PRINCIPLES:
- Research actual Etsy search volume and competition
- Include both broad and specific terms
- Mix product attributes with buyer motivations
- Use commercial intent keywords (gift, custom, personalized)
- Avoid overly competitive single-word tags
- Focus on buyer psychology and search behavior

CHARACTER OPTIMIZATION:
- Maximize the 20-character limit when beneficial
- Use abbreviations strategically (tshirt vs t-shirt)
- Combine related concepts (cat-mom-gift vs cat + mom + gift)
- Prioritize complete phrases over partial words

Return as comma-separated values: tag1,tag2,tag3,etc.
No additional text, formatting, or explanations.`;
}

function getSystemPromptForKeyFeatures() {
  return `Generate EXACTLY 13 compelling key features for an Etsy product listing that highlight benefits and drive purchasing decisions.

Each feature should be a complete, benefit-focused statement that tells customers why they need this product.

FEATURE ALLOCATION (13 total):
1-3. Material Quality & Construction
- Highlight premium materials, construction quality, durability
- Include specific technical details (fabric weight, thread count, etc.)
- Emphasize longevity and value

4-6. Design & Aesthetic Appeal
- Describe visual impact and artistic elements
- Mention print quality, color vibrancy, design placement
- Highlight unique creative aspects

7-8. Comfort & Fit
- Size range and fit details
- Comfort features and wearability
- Practical wearing benefits

9-10. Care & Maintenance
- Easy care instructions and durability
- Wash/care guidelines that preserve quality
- Maintenance benefits

11-12. Versatility & Use Cases
- Multiple wearing/usage occasions
- Styling possibilities and versatility
- Lifestyle integration benefits

13. Customer Experience
- Shipping, packaging, or satisfaction guarantee
- Customer service or brand value proposition

WRITING REQUIREMENTS:
- Each feature: 50-500 characters
- Use benefit-focused language ("you get", "provides", "ensures")
- Include specific details when possible
- Create desire through emotional triggers
- Use action words and positive language
- Make each feature unique and non-repetitive

Return as a JSON array of 13 strings, properly formatted.
Example: ["Feature one text here", "Feature two text here", ...]`;
}

function getSystemPromptForMaterials() {
  return `Generate EXACTLY 13 materials for an Etsy product listing that accurately represent all components used in the product.

REQUIREMENTS:
- Generate exactly 13 materials - no more, no less
- Each material MUST be 20 characters or less
- Use specific, accurate material names
- Include primary and secondary materials
- Cover manufacturing materials when relevant

MATERIAL CATEGORIES to include:
- Primary fabric/base material (cotton, polyester, ceramic, etc.)
- Ink/printing materials (dtg-ink, sublimation-ink)
- Thread/construction materials
- Finishing materials (coating, glaze)
- Packaging materials if premium (kraft-paper, tissue-paper)
- Care/maintenance materials if included

NAMING CONVENTIONS:
- Use lowercase with hyphens: "100%-cotton" not "100% Cotton"
- Be specific: "ring-spun-cotton" vs just "cotton"
- Include percentages for blends: "60-cotton-40-poly"
- Use industry standard terms
- Prioritize accuracy over marketing language

EXAMPLES:
For a cotton t-shirt: "100%-cotton", "dtg-ink", "cotton-thread", "water-based-ink", "preshrunk-fabric"
For a ceramic mug: "ceramic", "glaze", "sublimation-ink", "food-safe-coating", "dishwasher-safe"

Return as a JSON array of exactly 13 material strings.
Focus on accuracy and compliance with platform requirements.
Example: ["100%-cotton", "dtg-ink", "cotton-thread", ...]`;
}

function getSystemPromptForProductContent() {
  return `You are an expert e-commerce copywriter. Generate comprehensive product content optimized for Etsy sales and search ranking.

Create a JSON object with these exact keys: "title", "description", "tags", "key_features", and "materials".

CRITICAL JSON REQUIREMENTS:
- Response must be a single, valid JSON object
- All strings must have proper escape sequences (\\n for newlines, \\" for quotes)
- No markdown formatting or code blocks
- All arrays must contain the exact number of required items

CONTENT SPECIFICATIONS:

"title": 
- Maximum 140 characters
- Format: "[Keywords + Design] [Product Type] - [Brand] [Benefits]"
- SEO optimized for Etsy search
- Compelling and click-worthy

"description":
- 1800-2200 characters (longer ranks better)
- SEO-optimized with strategic keyword placement
- Structured with clear sections using \\n\\n for spacing
- Include: hook, quality details, design description, use cases, CTA
- First 160 characters crucial for meta description
- Natural keyword integration at 2-3% density

"tags":
- Array of exactly 13 strings
- Each tag 20 characters or less
- Mix of broad and long-tail keywords
- Focus on buyer search intent
- Format: ["tag-one", "tag-two", ...]

"key_features":
- Array of exactly 13 strings
- Each 50-500 characters
- Benefit-focused statements
- Cover quality, design, comfort, care, versatility, experience
- Format: ["Feature description here", ...]

"materials":
- Array of exactly 13 strings  
- Each 20 characters or less
- Accurate material representation
- Include primary, secondary, and manufacturing materials
- Format: ["material-one", "material-two", ...]

Return ONLY the JSON object, properly formatted and escaped.`;
}

// Helper functions
function buildFullPrompt(systemPrompt, enhancedPrompt) {
  return `${systemPrompt}

USER REQUEST: ${enhancedPrompt}

Generate the content following the exact specifications above.`;
}

async function processGeneratedContent(content, contentType) {
  switch (contentType) {
    case 'product-content':
      return await processProductContent(content);
    case 'tags':
      return await processTags(content);
    case 'key-features':
    case 'materials':
      return await processArrayContent(content, contentType);
    default:
      return { success: true, content: content.trim() };
  }
}

async function processProductContent(content) {
  try {
    // Remove common markdown fences and trim
    let cleanContent = String(content || '')
      .replace(/```json\n?/gi, '')
      .replace(/```/g, '')
      .trim();

    // Replace smart quotes with ASCII quotes to avoid JSON.parse failures
    cleanContent = cleanContent
      .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
      .replace(/[\u2018\u2019\u2032]/g, "'");

    // Try to locate a single JSON object substring
    let jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Heuristic: if keys are present without enclosing braces, attempt to wrap
      if (/"title"\s*:/.test(cleanContent) && /"description"\s*:/.test(cleanContent)) {
        const start = cleanContent.indexOf('"title"');
        const endDesc = cleanContent.lastIndexOf('"materials"');
        let candidate = cleanContent;
        if (start >= 0) candidate = cleanContent.slice(start);
        candidate = '{' + candidate;
        // Ensure it ends with a closing brace
        if (!/\}$/.test(candidate)) candidate = candidate + '}';
        jsonMatch = [candidate];
      }
      if (!jsonMatch) {
        console.warn('[generate-content] No JSON object found. Snippet:', cleanContent.slice(0,300));
        throw new Error('No valid JSON object found in response');
      }
    }

    let jsonString = jsonMatch[0];
    // Remove trailing commas before object/array closers which break JSON.parse
    jsonString = jsonString
      .replace(/,\s*\}/g, '}')
      .replace(/,\s*\]/g, ']');

    let parsedContent;
    try {
      parsedContent = JSON.parse(jsonString);
    } catch (e1) {
      // Second attempt: collapse stray newlines in keys/strings
      const retry = jsonString.replace(/\n+/g, '\\n');
      try {
        parsedContent = JSON.parse(retry);
      } catch (e2) {
        console.error('[generate-content] JSON parse failed. First 300 chars:', jsonString.slice(0,300));
        throw e2;
      }
    }
    
    // Validate required fields
    const requiredFields = ['title', 'description', 'tags', 'key_features', 'materials'];
    for (const field of requiredFields) {
      if (!parsedContent[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Validate array lengths
    if (!Array.isArray(parsedContent.tags) || parsedContent.tags.length !== 13) {
      throw new Error('Tags must be an array of exactly 13 items');
    }
    if (!Array.isArray(parsedContent.key_features) || parsedContent.key_features.length !== 13) {
      throw new Error('Key features must be an array of exactly 13 items');
    }
    if (!Array.isArray(parsedContent.materials) || parsedContent.materials.length !== 13) {
      throw new Error('Materials must be an array of exactly 13 items');
    }
    
    return { success: true, ...parsedContent };
  } catch (error) {
    throw new Error(`Failed to parse product content: ${error.message}`);
  }
}

async function processTags(content) {
  try {
    // Split by comma and clean up each tag
    let tags = content.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    
    // Debug log for each tag with index and length
    console.log('=== RAW TAGS DEBUG INFO ===');
    const rawTags = [...tags];
    rawTags.forEach((t, i) => {
      console.log(i, `'${t}'`, t.length);
    });
    console.log('=== END RAW TAGS DEBUG ===');
    
    // Check for tags longer than 20 characters
    const longTags = tags.filter(tag => tag.length > 20);
    if (longTags.length > 0) {
      console.warn(`Found ${longTags.length} tags exceeding 20 characters: ${longTags.join(', ')}`);
      
      // Truncate long tags to 20 characters
      tags = tags.map(tag => tag.substring(0, 20));
    }
    
    // Ensure we have exactly 13 tags
    if (tags.length < 13) {
      // If we have fewer than 13 tags, add generic ones to reach 13
      const genericTags = ['handmade', 'custom', 'unique', 'gift', 'quality', 'trendy', 'stylish', 'modern', 'classic', 'special', 'premium', 'exclusive', 'bestseller'];
      while (tags.length < 13) {
        const nextGeneric = genericTags[tags.length % genericTags.length];
        if (!tags.includes(nextGeneric)) {
          tags.push(nextGeneric);
        } else {
          // If the generic tag is already used, add a number suffix
          tags.push(`${nextGeneric}-item`);
        }
      }
      console.warn(`Added generic tags to reach 13 tags requirement`);
    } else if (tags.length > 13) {
      // If we have more than 13 tags, keep only the first 13
      tags = tags.slice(0, 13);
      console.warn(`Trimmed excess tags to meet 13 tags requirement`);
    }
    
    // Final validation
    if (tags.length !== 13) {
      throw new Error(`Failed to ensure exactly 13 tags, got ${tags.length}`);
    }
    
    // Check for duplicates and replace them
    const uniqueTags = new Set();
    tags = tags.map(tag => {
      if (uniqueTags.has(tag)) {
        // If duplicate, append a suffix
        const newTag = `${tag.substring(0, 16)}-alt`;
        uniqueTags.add(newTag);
        return newTag;
      } else {
        uniqueTags.add(tag);
        return tag;
      }
    });
    
    // Debug log for final processed tags
    console.log('=== FINAL TAGS DEBUG INFO ===');
    tags.forEach((t, i) => {
      console.log(i, `'${t}'`, t.length);
    });
    console.log('=== END FINAL TAGS DEBUG ===');
    
    return { success: true, content: tags };
  } catch (error) {
    throw new Error(`Failed to process tags: ${error.message}`);
  }
}

async function processArrayContent(content, contentType) {
  try {
    let cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    cleanContent = cleanContent.replace(/[""]/g, '"').replace(/['']/g, "'");
    
    const items = JSON.parse(cleanContent);
    if (!Array.isArray(items)) {
      throw new Error(`${contentType} response must be an array`);
    }
    if (items.length !== 13) {
      throw new Error(`Expected exactly 13 ${contentType}, got ${items.length}`);
    }
    return { success: true, content: items };
  } catch (error) {
    throw new Error(`Failed to process ${contentType}: ${error.message}`);
  }
}

async function storeAIContent(responseData, productId, contentType) {
  try {
    console.log('Storing AI content in database for productId:', productId);
    const supabaseUrl = process.env.SUPABASE_URL || 'https://opimwwjihemymwtdwdir.supabase.co';
    const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9waW13d2ppaGVteW13dGR3ZGlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjQ2MDI3NDcsImV4cCI6MjA0MDE3ODc0N30.VUgpgJJaVQIqU7zWUOhHQJmkdJBhXqJkKGBGLJBhXqI';
    
    const storeData = {
      product_id: productId,
      content_type: 'etsy',
      metadata: {
        tokens_used: responseData.tokens,
        generated_at: new Date().toISOString(),
        generation_type: contentType
      }
    };

    // Add content based on type
    if (contentType === 'product-content') {
      storeData.title = responseData.title || null;
      storeData.description = responseData.description || null;
      storeData.tags = responseData.tags || [];
      storeData.key_features = responseData.key_features || [];
      storeData.materials = responseData.materials || [];
    } else {
      storeData[contentType === 'key-features' ? 'key_features' : contentType] = responseData.content || null;
    }
    
    const storeResponse = await fetch(`${supabaseUrl}/rest/v1/ai_generated_content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseKey}`,
        'apikey': supabaseKey,
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(storeData)
    });
    
    if (storeResponse.ok) {
      console.log('AI content stored successfully in database');
    } else {
      const errorText = await storeResponse.text();
      console.warn('Failed to store AI content in database:', errorText);
    }
  } catch (error) {
    console.warn('Error storing AI content in database:', error.message);
  }
}
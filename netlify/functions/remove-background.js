// netlify/functions/remove-background.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Parse the uploaded image (assuming base64)
        const { image } = JSON.parse(event.body);
        
        if (!image) {
            throw new Error('No image provided');
        }
        
        // Create temp files
        const timestamp = Date.now();
        const inputPath = `/tmp/input_${timestamp}.jpg`;
        const outputPath = `/tmp/output_${timestamp}.png`;
        
        // Handle data URL format
        const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
        const imageBuffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(inputPath, imageBuffer);
        
        // Use rembg via Python
        const pythonCode = `
from rembg import remove
from PIL import Image
import sys

input_path = sys.argv[1]
output_path = sys.argv[2]

try:
    input_image = Image.open(input_path)
    output_image = remove(input_image)
    output_image.save(output_path)
    print("SUCCESS")
except Exception as e:
    print(f"ERROR: {e}")
`;
        
        fs.writeFileSync('/tmp/process.py', pythonCode);
        
        return new Promise((resolve) => {
            const process = spawn('python3', ['/tmp/process.py', inputPath, outputPath]);
            
            process.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    const resultBuffer = fs.readFileSync(outputPath);
                    const base64Result = resultBuffer.toString('base64');
                    
                    // Cleanup
                    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    if (fs.existsSync('/tmp/process.py')) fs.unlinkSync('/tmp/process.py');
                    
                    resolve({
                        statusCode: 200,
                        headers: { 'Access-Control-Allow-Origin': '*' },
                        body: JSON.stringify({
                            success: true,
                            image: `data:image/png;base64,${base64Result}`
                        })
                    });
                } else {
                    resolve({
                        statusCode: 500,
                        body: JSON.stringify({ error: 'Failed to process image' })
                    });
                }
            });
        });
        
    } catch (error) {
        resolve({
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ 
                success: false,
                error: error.message 
            })
        });
    }
};
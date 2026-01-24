require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const csv = require('csv-parser');
const { Readable } = require('stream');
const preIntentFilter = require('./preintentfilter'); 
const { google } = require('googleapis'); 
const app = express();
const crypto = require('crypto');
const fs = require('fs'); 
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const CACHE_DIR = path.join(__dirname, 'public', 'ai-cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Import database functions
let db;
try {
  db = require('./requestData');
  console.log('Database module loaded successfully');
} catch (error) {
  console.error('Failed to load requestData.js:', error);
  db = {
    getCachedData: async (type) => {
      console.log(`Fallback: getCachedData for ${type}`);
      return [];
    },
    executeUpdate: async (table, id, updateData) => {
      console.log(`Fallback: executeUpdate for ${table}, id: ${id}`);
      return { affectedRows: 0 };
    },
    getRecordById: async (table, id) => {
      console.log(`Fallback: getRecordById for ${table}, id: ${id}`);
      return null;
    },
    clearCache: (type) => {
      console.log(`Fallback: clearCache for ${type}`);
    },
    clearAllCaches: () => {
      console.log(`Fallback: clearAllCaches`);
    },
    getAllCacheStatus: () => {
      return {};
    }
  };
}
let adminUsers = [];
try {
  adminUsers = require('./adminUser.json');
} catch (error) {
  adminUsers = [];
}

const EMPLOYEE_NUMBERS = [
  "8368127760",  
  "9717350080",  
  "8860924190",  
  "7483654620" 
];

const otpStore = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve static files

// OpenAI configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || ''
});

let verifiedUsers = {};
let conversations = {}; 
let galleriesData = [];
let sellersData = []; 
let productsData = []; 

/**
 * Sends an OTP to the provided phone number
 * @param phoneNumber - The phone number to send OTP to (10 digits, may have A/U suffix)
 * @returns Promise with the OTP response
 */
const sendOtp = async (phoneNumberWithSuffix) => {
  try {
    // Parse phone number and suffix
    const { basePhone, suffix } = parsePhoneNumberWithSuffix(phoneNumberWithSuffix);
    
    if (!basePhone || basePhone.length !== 10 || !/^\d{10}$/.test(basePhone)) {
      throw new Error('Invalid phone number. Must be 10 digits with optional A/U suffix.');
    }

    // Validate suffix if present
    if (suffix && !['A', 'U', 'a', 'u'].includes(suffix)) {
      throw new Error('Invalid suffix. Only A (Admin) or U (User) allowed.');
    }

    // Create form data using URLSearchParams
    const formData = new URLSearchParams();
    formData.append('mobile', basePhone);
    
    console.log(`📱 Sending OTP to ${basePhone} (suffix: ${suffix || 'none'}) via ZuluShop API...`);
    
    // Make API request to send OTP
    const response = await axios.post(
      'https://zulushop.in/app/v1/api/send_otp_new',
      formData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000 // 10 second timeout
      }
    );
    
    console.log('Send OTP Response:', response.data);

    // Store request ID for verification with both base phone and full phone
    if (response.data && response.data.request_id) {
      otpStore.set(basePhone, {
        requestId: response.data.request_id,
        createdAt: Date.now(),
        suffix: suffix || null
      });
      
      // Also store with full phone for lookup
      otpStore.set(phoneNumberWithSuffix, {
        requestId: response.data.request_id,
        createdAt: Date.now(),
        suffix: suffix || null
      });
      
      // Clear stored OTP after 10 minutes
      setTimeout(() => {
        if (otpStore.has(basePhone)) {
          otpStore.delete(basePhone);
        }
        if (otpStore.has(phoneNumberWithSuffix)) {
          otpStore.delete(phoneNumberWithSuffix);
        }
        console.log(`Cleared OTP request for ${phoneNumberWithSuffix}`);
      }, 10 * 60 * 1000); // 10 minutes
    }
    
    return {
      ...response.data,
      basePhone,
      suffix
    };
  } catch (error) {
    console.error('Error sending OTP:', error);
    
    // For development/testing if API fails
    if (error.code === 'ECONNREFUSED' || error.response?.status >= 500) {
      console.log('⚠️ API unavailable, using development mode');
      
      // Parse phone number and suffix
      const { basePhone, suffix } = parsePhoneNumberWithSuffix(phoneNumberWithSuffix);
      
      if (!basePhone || basePhone.length !== 10) {
        throw new Error('Invalid phone number. Must be 10 digits with optional A/U suffix.');
      }
      
      // Generate a random 4-digit OTP for development
      const generatedOtp = Math.floor(1000 + Math.random() * 9000).toString();
      
      // Store in memory for development
      otpStore.set(basePhone, {
        otp: generatedOtp,
        requestId: `DEV-${Date.now()}`,
        createdAt: Date.now(),
        isDevMode: true,
        suffix: suffix || null
      });
      
      otpStore.set(phoneNumberWithSuffix, {
        otp: generatedOtp,
        requestId: `DEV-${Date.now()}`,
        createdAt: Date.now(),
        isDevMode: true,
        suffix: suffix || null
      });
      
      // Clear OTP after 10 minutes
      setTimeout(() => {
        if (otpStore.has(basePhone)) {
          otpStore.delete(basePhone);
        }
        if (otpStore.has(phoneNumberWithSuffix)) {
          otpStore.delete(phoneNumberWithSuffix);
        }
        console.log(`Cleared development OTP for ${phoneNumberWithSuffix}`);
      }, 10 * 60 * 1000);
      
      console.log(`📱 DEVELOPMENT: OTP for ${basePhone} (suffix: ${suffix || 'none'}): ${generatedOtp}`);
      
      return {
        error: false,
        provider: 'development',
        request_id: `DEV-${Date.now()}`,
        message: 'OTP sent successfully (development mode)',
        debugOtp: generatedOtp,
        basePhone,
        suffix
      };
    }
    
    throw error;
  }
};

/**
 * Verifies the OTP entered by the user
 * @param phoneNumberWithSuffix - The phone number with optional suffix to verify OTP for
 * @param otp - The OTP code entered by the user
 * @returns Promise with verification result including user status
 */
const verifyOtp = async (phoneNumberWithSuffix, otp) => {
  try {
    // Parse phone number and suffix
    const { basePhone, suffix } = parsePhoneNumberWithSuffix(phoneNumberWithSuffix);
    
    if (!basePhone || basePhone.length !== 10) {
      throw new Error('Invalid phone number. Must be 10 digits with optional A/U suffix.');
    }

    if (!otp || otp.length !== 4 || !/^\d{4}$/.test(otp)) {
      throw new Error('Invalid OTP code. Must be 4 digits.');
    }

    // Validate suffix if present
    if (suffix && !['A', 'U', 'a', 'u'].includes(suffix)) {
      throw new Error('Invalid suffix. Only A (Admin) or U (User) allowed.');
    }

    // Check if we have a stored request for this phone (try full phone first, then base phone)
    let stored = otpStore.get(phoneNumberWithSuffix) || otpStore.get(basePhone);
    
    if (!stored) {
      throw new Error('No OTP request found for this number. Please request a new OTP.');
    }

    // Check if OTP is expired
    const isExpired = Date.now() - stored.createdAt > 5 * 60 * 1000; // 5 minutes
    
    if (isExpired) {
      otpStore.delete(phoneNumberWithSuffix);
      otpStore.delete(basePhone);
      throw new Error('OTP has expired. Please request a new one.');
    }

    // If in development mode, check against stored OTP
    if (stored.isDevMode) {
      if (stored.otp === otp) {
        // Mark user as verified with full phone (including suffix)
        verifiedUsers[phoneNumberWithSuffix] = {
          verified: true,
          isAdmin: adminUsers.some(user => user.mobile === basePhone),
          verifiedAt: Date.now(),
          suffix: suffix || null,
          basePhone: basePhone
        };

        // Clear OTP from store
        otpStore.delete(phoneNumberWithSuffix);
        otpStore.delete(basePhone);

        console.log(`User ${phoneNumberWithSuffix} verified successfully (dev mode). Admin: ${verifiedUsers[phoneNumberWithSuffix].isAdmin}`);
        
        return {
          error: false,
          message: 'OTP verified successfully (development mode)',
          phoneNumber: phoneNumberWithSuffix,
          basePhone: basePhone,
          suffix: suffix,
          isAdmin: verifiedUsers[phoneNumberWithSuffix].isAdmin
        };
      } else {
        throw new Error('Invalid OTP code');
      }
    }

    const formData = new URLSearchParams();
    formData.append('mobile', basePhone);
    formData.append('otp', otp);
    
    console.log(`🔐 Verifying OTP for ${basePhone} (suffix: ${suffix || 'none'}) via ZuluShop API...`);
    
    const response = await axios.post(
      'https://zulushop.in/app/v1/api/verify_otp_new',
      formData,
      {
        headers: { 
          'Content-Type': 'application/x-www-form-urlencoded' 
        },
        timeout: 10000 
      }
    );

    const data = response.data;
    console.log('Verify OTP Response:', data);

    if (data.error) {
      throw new Error(data.message || 'OTP verification failed');
    }

    const isAdmin = adminUsers.some(user => user.mobile === basePhone);
    verifiedUsers[phoneNumberWithSuffix] = {
      verified: true,
      isAdmin: isAdmin,
      verifiedAt: Date.now(),
      suffix: suffix || null,
      basePhone: basePhone,
      token: data.token // Store token if available
    };

    // Clear OTP from store
    otpStore.delete(phoneNumberWithSuffix);
    otpStore.delete(basePhone);

    console.log(`User ${phoneNumberWithSuffix} verified successfully via API. Admin: ${isAdmin}`);
    
    return {
      error: false,
      message: 'OTP verified successfully',
      phoneNumber: phoneNumberWithSuffix,
      basePhone: basePhone,
      suffix: suffix,
      isAdmin: isAdmin,
      token: data.token
    };
    
  } catch (error) {
    console.error('Error verifying OTP:', error);
    
    if (error.code === 'ECONNREFUSED' || error.response?.status >= 500) {
      console.log('⚠️ API unavailable, checking against development OTP');
      
      const { basePhone, suffix } = parsePhoneNumberWithSuffix(phoneNumberWithSuffix);
      
      let stored = otpStore.get(phoneNumberWithSuffix) || otpStore.get(basePhone);
      
      if (stored && stored.isDevMode && stored.otp === otp) {
        verifiedUsers[phoneNumberWithSuffix] = {
          verified: true,
          isAdmin: adminUsers.some(user => user.mobile === basePhone),
          verifiedAt: Date.now(),
          suffix: suffix || null,
          basePhone: basePhone
        };

        otpStore.delete(phoneNumberWithSuffix);
        otpStore.delete(basePhone);

        console.log(`User ${phoneNumberWithSuffix} verified successfully (dev fallback). Admin: ${verifiedUsers[phoneNumberWithSuffix].isAdmin}`);
        
        return {
          error: false,
          message: 'OTP verified successfully (development fallback)',
          phoneNumber: phoneNumberWithSuffix,
          basePhone: basePhone,
          suffix: suffix,
          isAdmin: verifiedUsers[phoneNumberWithSuffix].isAdmin
        };
      }
    }
    
    throw error;
  }
};

/**
 * Helper function to parse phone number with optional suffix
 * @param phoneNumberWithSuffix - Phone number that may end with A or U
 * @returns { basePhone: string, suffix: string|null }
 */
function parsePhoneNumberWithSuffix(phoneNumberWithSuffix) {
  if (!phoneNumberWithSuffix || typeof phoneNumberWithSuffix !== 'string') {
    return { basePhone: null, suffix: null };
  }
  
  const trimmed = phoneNumberWithSuffix.trim();
  
  // Check if it ends with A or U (case-insensitive)
  const lastChar = trimmed.slice(-1).toUpperCase();
  
  if (lastChar === 'A' || lastChar === 'U') {
    // Extract base phone (all but last character) and suffix
    const basePhone = trimmed.slice(0, -1);
    return { 
      basePhone: basePhone, 
      suffix: lastChar 
    };
  }
  
  // No suffix, assume entire string is phone number
  return { 
    basePhone: trimmed, 
    suffix: null 
  };
}

// Middleware to check if user is authenticated
const checkAuthentication = (req, res, next) => {
  // First check body for sessionId or phoneNumber
  const sessionIdFromBody = req.body.sessionId || req.body.phoneNumber;
  
  console.log(`🔍 checkAuthentication: sessionIdFromBody=${sessionIdFromBody}, body=`, req.body);
  
  if (!sessionIdFromBody) {
    return res.status(400).json({
      success: false,
      error: 'Session ID or phone number is required'
    });
  }

  // Clean and validate the sessionId
  const sessionId = String(sessionIdFromBody).trim();
  
  // If session ID is a phone number (verified user)
  if (sessionId.match(/^\d{10}[AU]?$/)) {
    const user = verifiedUsers[sessionId];
    
    if (!user || !user.verified) {
      // User is not verified, but they can still access basic features
      // Create a session for them if it doesn't exist
      if (!conversations[sessionId]) {
        console.log(`🔄 Creating new session for unverified phone: ${sessionId}`);
        createOrTouchSession(sessionId, false);
      }
      
      req.isAuthenticated = false;
      req.sessionId = sessionId;
      next();
    } else {
      // User is verified and authenticated
      // Create a session for them if it doesn't exist
      if (!conversations[sessionId]) {
        console.log(`🔄 Creating new session for verified phone: ${sessionId}`);
        createOrTouchSession(sessionId, true);
      }
      
      req.user = user;
      req.phoneNumber = sessionId;
      req.isAuthenticated = true;
      req.sessionId = sessionId; // Make sure to set sessionId
      next();
    }
  } 
  // Temporary session ID (unauthenticated user)
  else {
    console.log(`🔍 Checking temporary session: ${sessionId}`);
    
    const session = conversations[sessionId];
    
    if (!session) {
      // If it's a guest session and doesn't exist, create it
      if (sessionId.startsWith('guest-')) {
        console.log(`Guest session ${sessionId} not found, creating new one`);
        createOrTouchSession(sessionId, false);
        req.sessionId = sessionId;
        req.isAuthenticated = false;
        next();
      } else {
        console.log(`Session ${sessionId} not found in conversations`);
        return res.status(400).json({
          success: false,
          error: 'Invalid session'
        });
      }
    } else {
      console.log(`Session ${sessionId} found, authenticated: ${session.isAuthenticated || false}`);
      req.sessionId = sessionId;
      req.isAuthenticated = session.isAuthenticated || false;
      next();
    }
  }
};
// -------------------------
// Google Sheets config
// -------------------------
const UPLOAD_API_URL = process.env.UPLOAD_API_URL || 'https://api.zulushop.in/api/v1/user/upload';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || 'History';
const AGENT_TICKETS_SHEET = process.env.AGENT_TICKETS_SHEET || 'Tickets_History';
const SA_JSON_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || '';

if (!GOOGLE_SHEET_ID) {
  console.log('⚠️ GOOGLE_SHEET_ID not set — sheet logging disabled');
}
if (!SA_JSON_B64) {
  console.log('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 not set — sheet logging disabled');
}

async function getSheets() {
  if (!GOOGLE_SHEET_ID || !SA_JSON_B64) return null;
  try {
    const keyJson = JSON.parse(Buffer.from(SA_JSON_B64, 'base64').toString('utf8'));
    const jwt = new google.auth.JWT(
      keyJson.client_email,
      null,
      keyJson.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    await jwt.authorize();
    return google.sheets({ version: 'v4', auth: jwt });
  } catch (e) {
    console.error('Error initializing Google Sheets client:', e);
    return null;
  }
}


function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function writeCell(colNum, rowNum, value) {
  const sheets = await getSheets();
  if (!sheets) return;
  const range = `${colLetter(colNum)}${rowNum}`;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] }
    });
  } catch (e) {
    console.error('writeCell error', e);
  }
}

function getIndiaTime() {
  const now = new Date();
  const offset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
  const indiaTime = new Date(now.getTime() + offset);
  
  // Format as: DD-MM-YYYY HH:MM:SS (24-hour format)
  const day = String(indiaTime.getUTCDate()).padStart(2, '0');
  const month = String(indiaTime.getUTCMonth() + 1).padStart(2, '0');
  const year = indiaTime.getUTCFullYear();
  const hours = String(indiaTime.getUTCHours()).padStart(2, '0');
  const minutes = String(indiaTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(indiaTime.getUTCSeconds()).padStart(2, '0');
  
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds}`;
}

// -------------------------
// Modified appendUnderColumn to prepend new messages
// -------------------------
async function appendUnderColumn(headerName, text) {
  const sheets = await getSheets();
  if (!sheets) return;
  
  try {
    const ts = getIndiaTime(); // Use India time
    const finalText = `${ts} | ${text}`;
    
    // Get header row to find column
    const headersResp = await sheets.spreadsheets.values.get({ 
      spreadsheetId: GOOGLE_SHEET_ID, 
      range: '1:1' 
    });
    const headers = (headersResp.data.values && headersResp.data.values[0]) || [];
    
    // Find or create column
    let colIndex = headers.findIndex(h => String(h).trim() === headerName);
    if (colIndex === -1) {
      colIndex = headers.length;
      const headerCol = colLetter(colIndex + 1) + '1';
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: headerCol,
        valueInputOption: 'RAW',
        requestBody: { values: [[headerName]] }
      });
    }
    
    const colNum = colIndex + 1;
    
    // Get existing values in this column (excluding header)
    const colRange = `${colLetter(colNum)}2:${colLetter(colNum)}`;
    let existingValues = [];
    
    try {
      const colResp = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: colRange,
        majorDimension: 'COLUMNS'
      });
      existingValues = (colResp.data.values && colResp.data.values[0]) || [];
    } catch (e) {
      existingValues = [];
    }
    
    // PREPEND the new message at the beginning (row 2)
    const newValues = [finalText, ...existingValues];
    
    // Write all values starting from row 2
    const writeRange = `${colLetter(colNum)}${2}:${colLetter(colNum)}${2 + newValues.length - 1}`;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: writeRange,
      valueInputOption: 'RAW',
      requestBody: { values: newValues.map(v => [v]) }
    });
    
    console.log(`📝 Prepended message to column "${headerName}" (${ts})`);
    
  } catch (e) {
    console.error('appendUnderColumn error', e);
  }
}

// -------------------------
// ZULU CLUB INFORMATION
// -------------------------
const ZULU_CLUB_INFO = `
Zulu Club is a lifestyle shopping app that delivers fashion, home decor, furniture & more in 100 mins or less.
Its tagline is: "Lifestyle upgrades, delivered ASAP’. It curates an assortment basis hyprlocal taste & life style choices & offers it to you on our app as well as our showrooms near you."
Users can discover & shop products on app & get delivery asap in 100 mins or less or they can visit any Zulu stores or , popups in markets near them. 
They can also watch videos of lifestyle outlets near them & call or WhatsApp chat directly with them without any middlemen.
The video watch tells us simply what consumers love and we find and locate those best sellers in our app. 
The platform operates primarily in Gurgaon, especially along Golf Course Extension Road.
Zulu runs the Zulu Club Experience Store at Shop 9, M3M Urbana Premium, Sector 67, Gurgaon as well in Sec 63, right next to Worldmark in Tyagi Market, near Auto Nation. We also conduct popups in markets near you. 
Core categories include 
Home Decor 
Fashion
Furniture
Footwear
Accessories
Lifestyle Gifting & Beauty & Self-Care.
Explore at https://zulu.club or via the Zulu Club apps on iOS and Android.
`;

const INVESTOR_KNOWLEDGE = `
Zulu Club operates under Madmind Tech Innovations Private Limited.
Founded in 2024 by Adarsh Bhatia and Anubhav Sadha.
The company is registered in Gurugram, Haryana, India.
GSTIN: 06AASCM5743R1ZH | PAN: AASCM5743R
Registered address: D20, 301, Ireo Victory Valley, Sector 67, Gurugram, Haryana 122101.
Zulu operates a hyperlocal lifestyle commerce model combining video discovery,
AI-powered curation, and fast local delivery.
Operations are concentrated along Golf Course Extension Road, Gurgaon.
Early traction includes 2,000+ customers, 8,000+ interactions,
4 markets, 20 societies, and a 20 sq km operating radius.
`;

const SELLER_KNOWLEDGE = `
Zulu Club can help you reach premium consumers in your region. 
We work directly with brands, outlets, factories as well as boutiques. 
We can take you live in 100 Mins and you can start showcasing your catalog on Zulu and get direct leads from premium consumers. They can call or whatsapp with you directly with zero commission & zero middlemen. 
We can even place your best sellers in any of our outlets in Gurgaon & help your brand get the right visibility it needs.
So go ahead, and reach out to uur representative to help your go live on Zulu. 
 
No paperwork, no catalog, no complexity, it just takes a few videos and you are live. 
High-performing products may be curated for bulk buying across partner stores.
`;

// -------------------------
// CSV loaders: products + galleries + sellers
// -------------------------
// Update the loadProductsData function with proper field mappings
async function loadProductsData() {
  try {
    console.log('Loading products CSV data...');
    const response = await axios.get('https://raw.githubusercontent.com/Rishi-Singhal-714/chatbot/main/products.csv', {
      timeout: 60000 
    });
        
    return new Promise((resolve, reject) => {
      const results = [];
      let rowCount = 0;
      
      if (!response.data || response.data.trim().length === 0) {
        console.log('Empty products CSV received');
        resolve([]);
        return;
      }
      
      const stream = Readable.from(response.data);  
      stream
        .pipe(csv())
        .on('data', (data) => {
          rowCount++;

          // Map CSV columns - try multiple variations
          const mappedData = {
            id: data.id || data.ID || data.product_id || '',
            name: data.name || data.Name || data.NAME || data.title || '',
            price: data.price || data.specialPrice || data.price || data.price || data.PRICE || '',
            image: data.image || data.Image || data.IMAGE || data.image_url || '',
            tags: data.tags || data.TAGS || data.Tags || data.tag || data.TAG || ''
          };      
          
          // Only include if we have basic info
          if (mappedData.name) {
            // Clean up tags
            if (mappedData.tags) {
              mappedData.tagsArray = mappedData.tags
                .split(',')
                .map(tag => tag.trim().toLowerCase())
                .filter(tag => tag.length > 0);
            } else {
              mappedData.tagsArray = [];
            }
            
            if (mappedData.price) {
              const priceStr = String(mappedData.price).trim();
              if (priceStr) {
                // Remove any non-numeric characters
                const cleaned = priceStr.replace(/[^\d.]/g, '');
                if (cleaned && !isNaN(parseFloat(cleaned))) {
                  mappedData.price = parseFloat(cleaned);
                  if (rowCount <= 5) {
                  }
                } else {
                  mappedData.price = null;
                  if (rowCount <= 5) {
                  }
                }
              } else {
                mappedData.price = null;
              }
            } else {
              mappedData.price = null;
            }
            
            results.push(mappedData);
          }
        })
        .on('end', () => {
          console.log(`Loaded ${results.length} products from ${rowCount} CSV rows`);
          resolve(results);
        })
        .on('error', (error) => {
          console.error('Error parsing products CSV:', error);
          reject(error);
        });
    });
  } catch (error) {
    console.error('Error loading products CSV:', error.message);
    return [];
  }
}

async function loadGalleriesData() {
  try {
    console.log('Loading galleries CSV data...');
    const response = await axios.get('https://raw.githubusercontent.com/Rishi-Singhal-714/chatbot/main/galleries3.csv', {
      timeout: 60000 
    });
    
    return new Promise((resolve, reject) => {
      const results = [];
      if (!response.data || response.data.trim().length === 0) {
        console.log('Empty CSV data received');
        resolve([]);
        return;
      }
      
      const stream = Readable.from(response.data);  
      stream
        .pipe(csv())
        .on('data', (data) => {
          const mappedData = {
            id: data.id || data.ID || '',
            type2: data.type2 || data.Type2 || data.TYPE2 || '',
            cat_id: data.cat_id || data.CAT_ID || '',
            cat1: data.cat1 || data.Cat1 || data.CAT1 || '',
            catname: data.catname || data.Catname || data.CATNAME || '',
            cat1name: data.cat1name || data.Cat1name || data.CAT1NAME || '',
            seller_id: data.seller_id || data.SELLER_ID || data.Seller_ID || data.SellerId || data.sellerId || '',
            name: data.name || data.Name || data.NAME || '',
            image1: data.image1 || data.Image1 || data.IMAGE1 || ''
          };      
          
          // Check if we have any of the required fields
          if (mappedData.type2 || mappedData.id || mappedData.name || mappedData.catname || mappedData.cat1name) {
            // Process category fields - split by comma and clean
            if (mappedData.catname) {
              mappedData.catnameArray = mappedData.catname
                .split(',')
                .map(item => item.trim().toLowerCase())
                .filter(item => item.length > 0);
            } else {
              mappedData.catnameArray = [];
            }
            
            if (mappedData.cat1name) {
              mappedData.cat1nameArray = mappedData.cat1name
                .split(',')
                .map(item => item.trim().toLowerCase())
                .filter(item => item.length > 0);
            } else {
              mappedData.cat1nameArray = [];
            }
            
            results.push(mappedData);
          }
        })
        .on('end', () => {
          console.log(`Loaded ${results.length} galleries from CSV`);
          resolve(results);
        })
        .on('error', (error) => {
          console.error('Error parsing CSV:', error);
          reject(error);
        });
    });
  } catch (error) {
    console.error('Error loading CSV data:', error.message);
    return [];
  }
}

async function loadSellersData() {
  try {
    console.log('Loading sellers CSV data...');
    const response = await axios.get('https://raw.githubusercontent.com/Rishi-Singhal-714/chatbot/main/sellers3.csv', {
      timeout: 60000
    });
    
    return new Promise((resolve, reject) => {
      const results = [];
      if (!response.data || response.data.trim().length === 0) {
        console.log('Empty sellers CSV received');
        resolve([]);
        return;
      }
      
      const stream = Readable.from(response.data);
      stream
        .pipe(csv())
        .on('data', (data) => {
          const mapped = {
            seller_id: data.seller_id || data.SELLER_ID || data.id || data.ID || '',
            user_id: data.user_id || data.USER_ID || data.userId || data.userID || '',
            store_name: data.store_name || data.StoreName || data.store || data.Store || '',
            category_ids: data.category_ids || data.CATEGORY_IDS || data.categories || data.Categories || '',
            raw: data
          };
          
          if (mapped.seller_id || mapped.store_name) {
            mapped.category_ids_array = (mapped.category_ids || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            results.push(mapped);
          }
        })
        .on('end', () => {
          console.log(`Loaded ${results.length} sellers from CSV`);
          resolve(results);
        })
        .on('error', (error) => {
          console.error('Error parsing sellers CSV:', error);
          reject(error);
        });
    });
  } catch (error) {
    console.error('Error loading sellers CSV:', error.message);
    return [];
  }
}

// initialize all CSVs - update the async initialization section
(async () => {
  try {
    galleriesData = await loadGalleriesData();
  } catch (e) {
    console.error('Failed loading galleries:', e);
    galleriesData = [];
  }
  
  try {
    sellersData = await loadSellersData();
  } catch (e) {
    console.error('Failed loading sellers:', e);
    sellersData = [];
  }

  try {
    productsData = await loadProductsData(); // Add this
  } catch (e) {
    console.error('Failed loading products:', e);
    productsData = [];
  }
})();

// -------------------------
// Agent ticket helpers (keep as is)
// -------------------------
async function generateTicketId() {
  const sheets = await getSheets();
  if (!sheets) {
    console.warn("Sheets not available — fallback random Ticket ID");
    const now = Date.now();
    return `TKT-${String(now).slice(-6)}`;
  }
  
  const COUNTER_CELL = `${AGENT_TICKETS_SHEET}!Z2`;
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: COUNTER_CELL
    });
    
    let current = resp.data.values?.[0]?.[0] ? Number(resp.data.values[0][0]) : 0;
    const next = current + 1;
    
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: COUNTER_CELL,
      valueInputOption: "RAW",
      requestBody: { values: [[next]] }
    });
    
    return `TKT-${String(next).padStart(6, "0")}`;
  } catch (err) {
    console.error("Ticket ID counter error:", err);
    return `TKT-${String(Date.now()).slice(-6)}`;
  }
}

async function ensureAgentTicketsHeader(sheets) {
  try {
    const sheetName = AGENT_TICKETS_SHEET;
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!1:1`
    }).catch(() => null);
    
    const existing = (resp && resp.data && resp.data.values && resp.data.values[0]) || [];
    const required = ['mobile_number', 'last_5th_message', '4th_message', '3rd_message', '2nd_message', '1st_message', 'ticket_id', 'ts'];
    
    if (existing.length === 0 || required.some((h, i) => String(existing[i] || '').trim().toLowerCase() !== h)) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${sheetName}!1:1`,
        valueInputOption: 'RAW',
        requestBody: { values: [required] }
      });
    }
    
    return sheetName;
  } catch (e) {
    console.error('ensureAgentTicketsHeader error', e);
    return AGENT_TICKETS_SHEET;
  }
}

async function createAgentTicket(mobileNumber, conversationHistory = []) {
  const sheets = await getSheets();
  if (!sheets) {
    console.warn('Google Sheets not configured — cannot write agent ticket');
    return generateTicketId();
  }
  
  try {
    const sheetName = await ensureAgentTicketsHeader(sheets);
    const userMsgs = (Array.isArray(conversationHistory) ? conversationHistory : [])
      .filter(m => m.role === 'user')
      .map(m => (m.content || ''));
    
    const lastFive = userMsgs.slice(-5);
    const pad = Array(Math.max(0, 5 - lastFive.length)).fill('');
    const arranged = [...pad, ...lastFive];
    const ticketId = await generateTicketId();
    const ts = getIndiaTime(); // Changed from new Date().toISOString()
    
    const row = [
      mobileNumber || '',
      arranged[0] || '',
      arranged[1] || '',
      arranged[2] || '',
      arranged[3] || '',
      arranged[4] || '',
      ticketId,
      ts
    ];
    
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A:Z`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });
    
    console.log(`📌 New Agent Ticket Created: ${ticketId} for ${mobileNumber}`);
    
    return ticketId;
  } catch (e) {
    console.error('createAgentTicket error', e);
    return generateTicketId();
  }
}

function normalizeToken(t) {
  if (!t) return '';
  return String(t)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(word) {
  if (!word) return '';
  if (word.endsWith('ies') && word.length > 3) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 3) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 2) return word.slice(0, -1);
  return word;
}

function editDistance(a, b) {
  const s = a || '', t = b || '';
  const m = s.length, n = t.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  
  return dp[m][n];
}

function calculateSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  if (longer.length === 0) return 1.0;
  if (longer.includes(shorter)) return 0.95;
  const commonChars = [...shorter].filter(char => longer.includes(char)).length;
  return commonChars / longer.length;
}

function smartSimilarity(a, b) {
  const A = singularize(normalizeToken(a));
  const B = singularize(normalizeToken(b));
  if (!A || !B) return 0;
  if (A === B) return 1.0;
  if (A.includes(B) || B.includes(A)) return 0.95;
  
  const ed = editDistance(A, B);
  const maxLen = Math.max(A.length, B.length);
  const edScore = 1 - (ed / Math.max(1, maxLen));
  const charOverlap = calculateSimilarity(A, B);
  
  return Math.max(edScore, charOverlap);
}

function expandCategoryVariants(category) {
  const norm = normalizeToken(category);
  const variants = new Set();
  if (norm) variants.add(norm);
  
  // Handle "Dresses, Handbags, Jewellery & Accessories, Sandals" type strings
  const commaParts = norm.split(',').map(s => s.trim()).filter(s => s.length > 0);
  for (const part of commaParts) {
    variants.add(part);
    
    // Also handle "&" within each part
    const ampParts = part.split(/\band\b/).map(s => normalizeToken(s));
    for (const p of ampParts) {
      if (p && p.length > 1) variants.add(p.trim());
    }
  }
  
  // Add singular forms
  const singularVariants = new Set();
  variants.forEach(v => {
    singularVariants.add(v);
    singularVariants.add(singularize(v));
  });
  
  return Array.from(singularVariants);
}

const STOPWORDS = new Set(['and','the','for','a','an','of','in','on','to','with','from','shop','buy','category','categories']);

function containsClothingKeywords(userMessage) {
  const clothingTerms = ['men', 'women', 'kids', 'kid', 'child', 'children', 'man', 'woman', 'boy', 'girl'];
  const message = (userMessage || '').toLowerCase();
  return clothingTerms.some(term => message.includes(term));
}

function findKeywordMatchesInCat1(userMessage) {
  if (!userMessage || !galleriesData.length) return [];
  
  const rawTerms = userMessage
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/\s+/)
    .filter(term => term.length > 1 && !STOPWORDS.has(term));
    
  const searchTerms = rawTerms
    .map(t => singularize(normalizeToken(t)))
    .filter(t => t.length > 1);
    
  const matches = [];
  const clothingKeywords = ['clothing', 'apparel', 'wear', 'shirt', 'pant', 'dress', 'top', 'bottom', 'jacket', 'sweater'];
  
  galleriesData.forEach(item => {
    if (!item.type2 && !item.name && !item.catname && !item.cat1name) return;
    
    // Collect all fields to search
    const searchFields = [];
    
    // Add type2
    if (item.type2) searchFields.push({ type: 'type2', value: item.type2 });
    
    // Add name
    if (item.name) searchFields.push({ type: 'name', value: item.name });
    
    // Add catname (split by comma)
    if (item.catname) {
      const catnameParts = item.catname.split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0);
      
      catnameParts.forEach(catname => {
        searchFields.push({ type: 'catname', value: catname });
      });
    }
    
    // Add cat1name (split by comma)
    if (item.cat1name) {
      const cat1nameParts = item.cat1name.split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0);
      
      cat1nameParts.forEach(cat1name => {
        searchFields.push({ type: 'cat1name', value: cat1name });
      });
    }
    
    // Also add cat1 if it exists
    if (item.cat1) {
      searchFields.push({ type: 'cat1', value: item.cat1 });
    }
    
    let bestScore = 0;
    let bestTerm = '';
    let matchedField = '';
    
    for (const searchTerm of searchTerms) {
      for (const field of searchFields) {
        // Expand variants for the field value
        const variants = expandCategoryVariants(field.value);
        
        for (const variant of variants) {
          const isClothing = clothingKeywords.some(clothing => variant.includes(clothing));
          if (isClothing) continue;
          
          const sim = smartSimilarity(variant, searchTerm);
          
          if (sim > bestScore) {
            bestScore = sim;
            bestTerm = searchTerm;
            matchedField = field.type;
          }
        }
      }
    }
    
    // Adjust threshold based on matched field
    const adjustedThreshold = matchedField === 'type2' || matchedField === 'name' ? 0.82 : 0.9;
    
    if (bestScore >= adjustedThreshold) {
      if (!matches.some(m => m.id === item.id)) {
        matches.push({
          ...item,
          matchType: bestScore === 1.0 ? 'exact' : 'similar',
          matchedTerm: bestTerm,
          matchedField: matchedField,
          score: bestScore
        });
      }
    }
  });
  
  return matches.sort((a, b) => b.score - a.score).slice(0, 10);
}

const MAX_GPT_SELLER_CHECK = 20;
const GPT_THRESHOLD = 0.7;
const GPT_HOME_THRESHOLD = 0.6;
const CLOTHING_IGNORE_WORDS = ['men','women','kid','kids','child','children','man','woman','boys','girls','mens','womens'];

function stripClothingFromType2(type2) {
  if (!type2) return type2;
  let tokens = type2.split(/\s+/);
  while (tokens.length && CLOTHING_IGNORE_WORDS.includes(tokens[0].toLowerCase().replace(/[^a-z]/g, ''))) {
    tokens.shift();
  }
  return tokens.join(' ').trim();
}

function matchSellersByStoreName(type2Value, detectedGender = null) {
  if (!type2Value || !sellersData.length) return [];
  
  const stripped = stripClothingFromType2(type2Value);
  const norm = normalizeToken(stripped);
  if (!norm) return [];
  
  const matches = [];
  sellersData.forEach(seller => {
    const store = seller.store_name || '';
    const sim = smartSimilarity(store, norm);
    if (sim < 0.82) return;
    
    if (detectedGender) {
      const sellerGenders = new Set();
      (seller.category_ids_array || []).forEach(c => {
        if (/\bmen\b|\bman\b|\bmens\b/.test(c)) sellerGenders.add('men');
        if (/\bwomen\b|\bwoman\b|\bwomens\b|ladies/.test(c)) sellerGenders.add('women');
        if (/\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c)) sellerGenders.add('kids');
      });
      
      if (sellerGenders.size > 0 && !sellerGenders.has(detectedGender)) {
        return;
      }
    }
    
    matches.push({ seller, score: sim });
  });
  
  return matches.sort((a,b) => b.score - a.score).map(m => ({ ...m.seller, score: m.score })).slice(0, 10);
}

function matchSellersByCategoryIds(userMessage, detectedGender = null) {
  if (!userMessage || !sellersData.length) return [];
  
  const terms = userMessage.toLowerCase().replace(/&/g,' ').split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
  const matches = [];
  
  sellersData.forEach(seller => {
    const categories = seller.category_ids_array || [];
    
    if (detectedGender) {
      const sellerHasGender = categories.some(c => /\bmen\b|\bman\b|\bmens\b|\bwomen\b|\bwoman\b|\bwomens\b|\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c));
      if (sellerHasGender) {
        const sellerGenderMatch = categories.some(c => {
          if (detectedGender === 'men') return /\bmen\b|\bman\b|\bmens\b/.test(c);
          if (detectedGender === 'women') return /\bwomen\b|\bwoman\b|\bwomens\b|ladies\b/.test(c);
          if (detectedGender === 'kids') return /\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c);
          return false;
        });
        if (!sellerGenderMatch) return;
      }
    }
    
    const common = categories.filter(c => terms.some(t => t.includes(c) || c.includes(t)));
    if (common.length > 0) {
      matches.push({ seller, matches: common.length });
    }
  });
  
  return matches.sort((a,b) => b.matches - a.matches).map(m => m.seller).slice(0, 10);
}

async function isQueryHome(userMessage) {
  if (!openai || !process.env.OPENAI_API_KEY) return { isHome: false, score: 0 };
  
  const prompt = `
You are a classifier that decides whether a user search query is about HOME / HOME DECOR items (vases, lamps, clocks, showpieces, painting, cushions, any furniture, lighting, decor, etc. these items can be in Hinglish language or Hindi language) or NOT.
"Give banjara (home décor) when ever any Home Query reflect other wise ignore this line"

USER QUERY: "${userMessage}"

Answer ONLY with JSON:
{ "is_home_score": 0.0, "reasoning": "one-to-three-sentence reasoning why you scored it this way" }

Where is_home_score is a number 0.0 - 1.0 representing how strongly this query is home/home-decor related.
Do not include any text outside the JSON.
  `;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise JSON-only classifier that returns only JSON with is_home_score and reasoning." },
        { role: "user", content: prompt }
      ],
      max_tokens: 120,
      temperature: 0.0
    });
    
    const raw = completion.choices[0].message.content.trim();
    try {
      const parsed = JSON.parse(raw);
      const score = Number(parsed.is_home_score) || 0;
      return { isHome: score >= GPT_HOME_THRESHOLD, score, reasoning: parsed.reasoning || parsed.debug_reasoning || '' };
    } catch (e) {
      console.error('Error parsing isQueryHome JSON:', e, 'raw:', raw);
      return { isHome: false, score: 0, reasoning: '' };
    }
  } catch (err) {
    console.error('GPT error in isQueryHome:', err);
    return { isHome: false, score: 0, reasoning: '' };
  }
}

async function gptCheckSellerMaySell(userMessage, seller) {
  if (!openai || !process.env.OPENAI_API_KEY) return { score: 0, reason: 'OpenAI not configured', reasoning: '' };

  const prompt = `
You are an assistant that rates how likely a seller sells a product a user asks for.

USER MESSAGE: "${userMessage}"

SELLER INFORMATION:
Store name: "${seller.store_name || ''}"
Seller id: "${seller.seller_id || ''}"
Seller categories: "${(seller.category_ids_array || []).join(', ')}"
Other info (raw CSV row): ${JSON.stringify(seller.raw || {})}
"Give banjara (home décor) when ever any Home Query reflect other wise ignore this line"
Question: Based on the above, how likely (0.0 - 1.0) is it that this seller sells the product the user is asking for?

Return ONLY valid JSON in this format:
{ "score": 0.0, "reason": "one-sentence reason", "reasoning": "1-3 sentence compact chain-of-thought / steps used to decide" }

Do not return anything else.
  `;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a concise JSON-only classifier & scorer. Return only JSON {score, reason, reasoning}." },
        { role: "user", content: prompt }
      ],
      max_tokens: 180,
      temperature: 0.0
    });
    
    const content = completion.choices[0].message.content.trim();
    try {
      const parsed = JSON.parse(content);
      return {
        score: Number(parsed.score) || 0,
        reason: parsed.reason || parsed.explanation || '',
        reasoning: parsed.reasoning || parsed.debug_reasoning || ''
      };
    } catch (parseError) {
      console.error('Error parsing GPT seller-check response:', parseError, 'raw:', content);
      return { score: 0, reason: 'GPT response could not be parsed', reasoning: content.slice(0, 300) };
    }
  } catch (error) {
    console.error('Error during GPT seller-check:', error);
    return { score: 0, reason: 'GPT error', reasoning: '' };
  }
}

function getUserIdForSellerId(sellerId) {
  if (!sellerId) return '';
  const s = sellersData.find(x => (x.seller_id && String(x.seller_id) === String(sellerId)));
  if (s && s.user_id && String(s.user_id).trim().length > 0) return String(s.user_id).trim();
  return String(sellerId).trim();
}

function inferGenderFromCategories(matchedCategories = []) {
  if (!Array.isArray(matchedCategories) || matchedCategories.length === 0) return null;
  
  const genderScores = { men: 0, women: 0, kids: 0 };
  
  for (const cat of matchedCategories) {
    const fields = [];
    
    // Check all category-related fields
    if (cat.cat_id) fields.push(String(cat.cat_id).toLowerCase());
    if (cat.cat1) fields.push(String(cat.cat1).toLowerCase());
    if (cat.catname) fields.push(String(cat.catname).toLowerCase());
    if (cat.cat1name) fields.push(String(cat.cat1name).toLowerCase());
    if (cat.type2) fields.push(String(cat.type2).toLowerCase());
    if (cat.name) fields.push(String(cat.name).toLowerCase());
    
    // For array fields
    if (cat.catnameArray && Array.isArray(cat.catnameArray)) {
      fields.push(...cat.catnameArray.map(c => c.toLowerCase()));
    }
    if (cat.cat1nameArray && Array.isArray(cat.cat1nameArray)) {
      fields.push(...cat.cat1nameArray.map(c => c.toLowerCase()));
    }
    
    const combined = fields.join(' ');
    if (/\bmen\b|\bman\b|\bmens\b/.test(combined)) genderScores.men += 1;
    if (/\bwomen\b|\bwoman\b|\bwomens\b|ladies/.test(combined)) genderScores.women += 1;
    if (/\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(combined)) genderScores.kids += 1;
  }
  
  const max = Math.max(genderScores.men, genderScores.women, genderScores.kids);
  if (max === 0) return null;
  
  const winners = Object.keys(genderScores).filter(k => genderScores[k] === max);
  if (winners.length === 1) return winners[0];
  
  return null;
}
function matchGalleriesByAllFields(userMessage) {
  if (!userMessage || !galleriesData.length) return [];
  
  const searchTerms = userMessage
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[\s,]+/)
    .filter(term => term.length > 2 && !STOPWORDS.has(term))
    .map(t => singularize(normalizeToken(t)));
  
  if (searchTerms.length === 0) return [];
  
  const matches = [];
  
  galleriesData.forEach(item => {
    let totalScore = 0;
    let matchedFields = [];
    
    // Check each field and collect scores
    searchTerms.forEach(term => {
      // Check type2
      if (item.type2) {
        const sim = smartSimilarity(item.type2, term);
        if (sim > 0.8) {
          totalScore += sim;
          if (!matchedFields.includes('type2')) matchedFields.push('type2');
        }
      }
      
      // Check name
      if (item.name) {
        const sim = smartSimilarity(item.name, term);
        if (sim > 0.8) {
          totalScore += sim;
          if (!matchedFields.includes('name')) matchedFields.push('name');
        }
      }
      
      // Check catname array
      if (item.catnameArray && item.catnameArray.length > 0) {
        item.catnameArray.forEach(cat => {
          const sim = smartSimilarity(cat, term);
          if (sim > 0.85) {
            totalScore += sim;
            if (!matchedFields.includes('catname')) matchedFields.push('catname');
          }
        });
      }
      
      // Check cat1name array
      if (item.cat1nameArray && item.cat1nameArray.length > 0) {
        item.cat1nameArray.forEach(cat => {
          const sim = smartSimilarity(cat, term);
          if (sim > 0.85) {
            totalScore += sim;
            if (!matchedFields.includes('cat1name')) matchedFields.push('cat1name');
          }
        });
      }
    });
    
    // Calculate average score
    if (matchedFields.length > 0) {
      const avgScore = totalScore / searchTerms.length;
      if (avgScore > 0.7) {
        matches.push({
          ...item,
          score: avgScore,
          matchedFields: matchedFields,
          matchCount: matchedFields.length
        });
      }
    }
  });
  
  // Sort by score and match count
  return matches
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.matchCount - a.matchCount;
    })
    .slice(0, 10);
}
async function findSellersForQuery(userMessage, galleryMatches = [], detectedGender = null) {
  const homeCheck = await isQueryHome(userMessage);
  const applyHomeFilter = homeCheck.isHome;
  
  if (!detectedGender) {
    detectedGender = inferGenderFromCategories(galleryMatches);
  }
  
  const sellers_by_type2 = new Map();
  for (const gm of galleryMatches) {
    const type2 = gm.type2 || '';
    const found = matchSellersByStoreName(type2, detectedGender);
    found.forEach(s => sellers_by_type2.set(s.seller_id || (s.store_name+'#'), s));
  }
  
  const catMatches = matchSellersByCategoryIds(userMessage, detectedGender);
  const sellers_by_category = new Map();
  catMatches.forEach(s => sellers_by_category.set(s.seller_id || (s.store_name+'#'), s));
  
  if (applyHomeFilter) {
    const homeSyns = ['home','decor','home decor','home-decor','home_decor','furniture','homeaccessories','home-accessories','home_accessories','decoratives','showpiece','showpieces','lamp','lamps','vase','vases','clock','clocks','cushion','cushions'];
    const keepIfHome = (s) => {
      const arr = s.category_ids_array || [];
      return arr.some(c => {
        const cc = c.toLowerCase();
        return homeSyns.some(h => cc.includes(h) || h.includes(cc));
      });
    };
    
    for (const [k, s] of Array.from(sellers_by_type2.entries())) {
      if (!keepIfHome(s)) sellers_by_type2.delete(k);
    }
    
    for (const [k, s] of Array.from(sellers_by_category.entries())) {
      if (!keepIfHome(s)) sellers_by_category.delete(k);
    }
  }
  
  const candidateIds = new Set([...sellers_by_type2.keys(), ...sellers_by_category.keys()]);
  const candidateList = [];
  
  if (candidateIds.size === 0) {
    if (applyHomeFilter) {
      for (const s of sellersData) {
        const arr = s.category_ids_array || [];
        if (arr.some(c => c.includes('home') || c.includes('decor') || c.includes('furnit') || c.includes('vase') || c.includes('lamp') || c.includes('clock'))) {
          candidateList.push(s);
          if (candidateList.length >= MAX_GPT_SELLER_CHECK) break;
        }
      }
    }
    
    for (let i = 0; i < Math.min(MAX_GPT_SELLER_CHECK, sellersData.length) && candidateList.length < MAX_GPT_SELLER_CHECK; i++) {
      const s = sellersData[i];
      if (!s) continue;
      
      if (detectedGender) {
        const categories = s.category_ids_array || [];
        const sellerHasGender = categories.some(c => /\bmen\b|\bman\b|\bmens\b|\bwomen\b|\bwoman\b|\bwomens\b|\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c));
        if (sellerHasGender) {
          const genderMatch = detectedGender === 'men' ? categories.some(c => /\bmen\b|\bman\b|\bmens\b/.test(c))
                          : detectedGender === 'women' ? categories.some(c => /\bwomen\b|\bwoman\b|\bwomens\b|ladies\b/.test(c))
                          : categories.some(c => /\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c));
          if (!genderMatch) continue;
        }
      }
      
      if (!candidateList.includes(s)) candidateList.push(s);
    }
  } else {
    for (const id of candidateIds) {
      const s = sellersData.find(x => (x.seller_id == id) || ((x.store_name+'#') == id));
      if (s) candidateList.push(s);
    }
    
    if (candidateList.length < MAX_GPT_SELLER_CHECK) {
      for (const s of sellersData) {
        if (candidateList.length >= MAX_GPT_SELLER_CHECK) break;
        if (!candidateList.includes(s)) {
          if (detectedGender) {
            const categories = s.category_ids_array || [];
            const sellerHasGender = categories.some(c => /\bmen\b|\bman\b|\bmens\b|\bwomen\b|\bwoman\b|\bwomens\b|\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c));
            if (sellerHasGender) {
              const genderMatch = detectedGender === 'men' ? categories.some(c => /\bmen\b|\bman\b|\bmens\b/.test(c))
                            : detectedGender === 'women' ? categories.some(c => /\bwomen\b|\bwoman\b|\bwomens\b|ladies\b/.test(c))
                            : categories.some(c => /\bkid\b|\bkids\b|\bchild\b|\bchildren\b/.test(c));
              if (!genderMatch) continue;
            }
          }
          candidateList.push(s);
        }
      }
    }
  }
  
  const sellers_by_gpt = [];
  const toCheck = candidateList.slice(0, MAX_GPT_SELLER_CHECK);
  const gptPromises = toCheck.map(async (seller) => {
    if (applyHomeFilter) {
      const arr = seller.category_ids_array || [];
      const isHome = arr.some(c => 
        c.includes("home") || c.includes("decor") || 
        c.includes("lamp") || c.includes("vase") || 
        c.includes("clock") || c.includes("furnit")
      );
      if (!isHome) return null;
    }
    
    const result = await gptCheckSellerMaySell(userMessage, seller);
    if (result.score > GPT_THRESHOLD) {
      return { seller, score: result.score, reason: result.reason };
    }
    return null;
  });
  
  const gptResults = await Promise.all(gptPromises);
  gptResults.forEach(r => {
    if (r) sellers_by_gpt.push(r);
  });
  
  const sellersType2Arr = Array.from(sellers_by_type2.values()).slice(0, 10);
  const sellersCategoryArr = Array.from(sellers_by_category.values()).slice(0, 10);
  
  return {
    by_type2: sellersType2Arr,
    by_category: sellersCategoryArr,
    by_gpt: sellers_by_gpt,
    homeCheck
  };
}

function urlEncodeType2(t) {
  if (!t) return '';
  return encodeURIComponent(t.trim().replace(/\s+/g, ' ')).replace(/%20/g, '%20');
}

// First, search products based on query with fuzzy matching
async function searchProductsForQuery(userMessage) {
  if (!userMessage || !productsData.length) return [];
  
  console.log(`🔍 Searching products for: "${userMessage}"`);
  
  // Step 1: Normalize query and create search tokens
  const query = userMessage.toLowerCase();
  
  // Expand query with common variants
  const queryVariants = expandQueryVariants(query);
  
  // Step 2: Score products based on multiple criteria
  const scoredProducts = productsData.map(product => {
    let score = 0;
    let matchedFields = [];
    let matchDetails = [];
    
    // A. NAME MATCHING (Highest weight)
    if (product.name) {
      const name = product.name.toLowerCase();
      
      // Exact match in name
      if (name.includes(query)) {
        score += 2.0;
        matchedFields.push('name_exact');
        matchDetails.push(`Exact match in name: "${product.name}"`);
      }
      
      // Token matching in name
      const queryTokens = query.split(/\s+/).filter(t => t.length > 2);
      const nameTokens = name.split(/\s+/);
      
      let nameTokenMatches = 0;
      queryTokens.forEach(qToken => {
        nameTokens.forEach(nToken => {
          if (smartSimilarity(qToken, nToken) > 0.85) {
            nameTokenMatches++;
          }
        });
      });
      
      if (nameTokenMatches > 0) {
        score += (nameTokenMatches * 0.5);
        matchedFields.push('name_tokens');
        matchDetails.push(`${nameTokenMatches} token(s) matched in name`);
      }
      
      // Check query variants
      queryVariants.forEach(variant => {
        if (name.includes(variant)) {
          score += 0.7;
          matchedFields.push('name_variant');
          matchDetails.push(`Variant match: "${variant}" in name`);
        }
      });
    }
    
    // B. TAGS MATCHING (Medium weight)
    if (product.tagsArray && product.tagsArray.length > 0) {
      // Check each tag
      let tagMatches = 0;
      let matchedTags = [];
      
      product.tagsArray.forEach(tag => {
        // Check exact tag match
        if (query.includes(tag)) {
          tagMatches += 2;
          matchedTags.push(tag);
        }
        
        // Check tag contains query words
        queryVariants.forEach(variant => {
          if (tag.includes(variant)) {
            tagMatches += 1;
            matchedTags.push(`${tag} (${variant})`);
          }
        });
        
        // Fuzzy tag matching
        query.split(/\s+/).forEach(qWord => {
          if (qWord.length > 2 && smartSimilarity(qWord, tag) > 0.8) {
            tagMatches += 0.5;
            matchedTags.push(`${tag} ≈ ${qWord}`);
          }
        });
      });
      
      if (tagMatches > 0) {
        score += Math.min(tagMatches, 5); // Cap tag score at 5
        matchedFields.push('tags');
        matchDetails.push(`Matched tags: ${matchedTags.slice(0, 3).join(', ')}`);
      }
    }
    
    // C. PRICE/BRAND HINTS (if query contains price/brand indicators)
    if (containsPriceOrBrand(query, product)) {
      score += 0.5;
      matchedFields.push('price_brand');
    }
    
    return {
      ...product,
      score: score,
      matchedFields: matchedFields,
      matchDetails: matchDetails,
      id: product.id || `product-${Date.now()}-${Math.random()}`
    };
  });
  
  // Step 3: Filter and sort
  const filteredProducts = scoredProducts
    .filter(p => p.score > 0.5) // Minimum threshold
    .sort((a, b) => b.score - a.score);
  
  console.log(`✅ Found ${filteredProducts.length} product matches`);
  
  // Step 4: If few results, try broader matching
  if (filteredProducts.length < 3) {
    return getFallbackMatches(query);
  }
  
  return filteredProducts.slice(0, 5);
}

// Helper: Expand query with common variants
function expandQueryVariants(query) {
  const variants = new Set();
  const words = query.split(/\s+/).filter(w => w.length > 2);
  
  words.forEach(word => {
    variants.add(word);
    variants.add(singularize(word));
    
    // Common spelling variations
    if (word.endsWith('s')) variants.add(word.slice(0, -1));
    if (word.includes('ie')) variants.add(word.replace('ie', 'y'));
    if (word.includes('y')) variants.add(word.replace('y', 'ie'));
    
    // Common product word expansions
    const expansions = {
      'tshirt': ['t-shirt', 'tee', 't shirt'],
      't-shirt': ['tshirt', 'tee'],
      'jeans': ['pant', 'trouser'],
      'top': ['shirt', 'blouse'],
      'dress': ['gown', 'frock'],
      'shoes': ['footwear', 'sneakers'],
      'bag': ['purse', 'handbag'],
      'watch': ['wristwatch', 'timepiece'],
      'furniture': ['furnishing', 'home decor'],
      'decor': ['decoration', 'home decor']
    };
    
    if (expansions[word]) {
      expansions[word].forEach(v => variants.add(v));
    }
  });
  
  return Array.from(variants);
}

// Helper: Check for price/brand indicators
function containsPriceOrBrand(query, product) {
  const priceIndicators = ['rs', '₹', 'rupee', 'price', 'cost', 'under', 'above', 'discount'];
  const hasPriceHint = priceIndicators.some(indicator => query.includes(indicator));
  
  if (!hasPriceHint) return false;
  
  // If query mentions price range, check if product price matches
  const priceMatch = query.match(/(\d+)\s*(rs|₹|rupees?)/i);
  if (priceMatch && product.price) {
    const mentionedPrice = parseInt(priceMatch[1]);
    const productPrice = parseFloat(product.price) || 0;
    
    if (productPrice > 0) {
      // Check if product price is within 20% of mentioned price
      const priceDiff = Math.abs(productPrice - mentionedPrice) / mentionedPrice;
      return priceDiff <= 0.2;
    }
  }
  
  return false;
}

// Fallback matching for limited results
function getFallbackMatches(query) {
  console.log('🔄 Using fallback matching...');
  
  const fallbackMatches = [];
  const queryWords = query.split(/\s+/).filter(w => w.length > 2);
  
  productsData.forEach(product => {
    let score = 0;
    
    // Check name
    if (product.name) {
      const name = product.name.toLowerCase();
      queryWords.forEach(qWord => {
        if (name.includes(qWord)) score += 0.5;
        else if (smartSimilarity(qWord, name) > 0.7) score += 0.3;
      });
    }
    
    // Check tags
    if (product.tagsArray) {
      queryWords.forEach(qWord => {
        product.tagsArray.forEach(tag => {
          if (tag.includes(qWord)) score += 0.3;
        });
      });
    }
    
    if (score > 0.5) {
      fallbackMatches.push({
        ...product,
        score: score,
        matchedFields: ['fallback'],
        matchDetails: ['Broad match based on keywords']
      });
    }
  });
  
  return fallbackMatches
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function matchGalleriesByStoreName(query, productMatches = []) {
  if (!query || !galleriesData.length) return [];
  
  console.log('🔍 Matching galleries by store name...');
  
  // Extract store names from query
  const potentialStoreNames = extractStoreNames(query);
  const matchedGalleries = [];
  
  galleriesData.forEach(gallery => {
    let score = 0;
    let matchedFields = [];
    
    // Priority 1: Check type2 (often contains store name)
    if (gallery.type2) {
      const type2 = gallery.type2.toLowerCase();
      
      potentialStoreNames.forEach(storeName => {
        if (type2.includes(storeName) || smartSimilarity(type2, storeName) > 0.85) {
          score += 2.0;
          matchedFields.push('store_name');
        }
      });
    }
    
    // Priority 2: Check name field
    if (gallery.name && score < 1) {
      const name = gallery.name.toLowerCase();
      
      potentialStoreNames.forEach(storeName => {
        if (name.includes(storeName)) {
          score += 1.5;
          matchedFields.push('gallery_name');
        }
      });
    }
    
    // Priority 3: Check if gallery categories match product categories
    if (productMatches.length > 0 && gallery.catnameArray) {
      productMatches.forEach(product => {
        if (product.tagsArray) {
          const commonCategories = gallery.catnameArray.filter(cat =>
            product.tagsArray.some(tag => 
              smartSimilarity(cat, tag) > 0.7 || 
              tag.includes(cat) || 
              cat.includes(tag)
            )
          );
          
          if (commonCategories.length > 0) {
            score += (commonCategories.length * 0.3);
            matchedFields.push('category_match');
          }
        }
      });
    }
    
    if (score > 0.8) {
      matchedGalleries.push({
        ...gallery,
        score: score,
        matchedFields: matchedFields,
        isStore: matchedFields.includes('store_name')
      });
    }
  });
  
  return matchedGalleries
    .sort((a, b) => {
      // Prioritize store matches over category matches
      if (a.isStore && !b.isStore) return -1;
      if (!a.isStore && b.isStore) return 1;
      return b.score - a.score;
    })
    .slice(0, 3);
}

// Extract potential store names from query
function extractStoreNames(query) {
  const storeIndicators = [
    'store', 'shop', 'boutique', 'showroom', 'outlet', 'brand', 
    'by', 'from', 'at', 'in', 'designer', 'collection'
  ];
  
  const words = query.toLowerCase().split(/\s+/);
  const storeNames = [];
  let collectingName = false;
  let currentName = [];
  
  words.forEach((word, index) => {
    // Skip common words
    if (['the', 'a', 'an', 'and', 'or', 'for'].includes(word)) return;
    
    // Check if this word indicates a store name might follow
    if (storeIndicators.includes(word) || 
        word.endsWith("'s") || 
        word.includes('-')) {
      collectingName = true;
      return;
    }
    
    // If collecting store name, add capitalized words
    if (collectingName && word.length > 2 && /^[A-Z][a-z]*$/.test(word.charAt(0).toUpperCase() + word.slice(1))) {
      currentName.push(word);
    } else if (currentName.length > 0) {
      storeNames.push(currentName.join(' '));
      currentName = [];
      collectingName = false;
    }
  });
  
  // Add any remaining name
  if (currentName.length > 0) {
    storeNames.push(currentName.join(' '));
  }
  
  // Also check for known store patterns in query
  const knownStores = ['zara', 'h&m', 'h&m', 'levi\'s', 'nike', 'adidas', 'puma', 'gucci', 'prada'];
  knownStores.forEach(store => {
    if (query.includes(store)) {
      storeNames.push(store);
    }
  });
  
  return [...new Set(storeNames)];
}

// Helper function for keyword matching
async function getKeywordMatches(userMessage) {
  const searchTerms = userMessage
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > 1);
  
  if (searchTerms.length === 0) return [];
  
  const keywordMatches = [];
  const exactMatches = [];
  
  productsData.forEach((product) => {
    if (!product || !product.name) return;
    
    const productName = product.name.toLowerCase();
    const productTags = product.tagsArray || [];
    
    let score = 0;
    let matchedFields = [];
    
    // Check each search term
    searchTerms.forEach(term => {
      // Check in name
      if (productName.includes(term)) {
        score += 0.7;
        matchedFields.push('name');
      }
      
      // Check in tags
      if (productTags.some(tag => tag.includes(term))) {
        score += 0.5;
        matchedFields.push('tags');
      }
    });
    
    // Also check if any tag contains the entire query
    const queryLower = userMessage.toLowerCase();
    if (productTags.some(tag => tag.includes(queryLower))) {
      score += 1.0;
      matchedFields.push('tags_full_query');
    }
    
    if (score > 0.4) {
      const match = {
        id: product.id,
        name: product.name,
        price: product.price || null,
        image: product.image || null,
        tagsArray: product.tagsArray || [],
        score: score,
        matchedFields: matchedFields,
        raw: product
      };
      
      keywordMatches.push(match);
      
      if (score > 1.0 || matchedFields.includes('tags_full_query')) {
        exactMatches.push(match);
      }
    }
  });
  
  if (exactMatches.length > 0) {
    console.log(`Found ${exactMatches.length} exact tag matches`);
    return exactMatches.sort((a, b) => b.score - a.score).slice(0, 5);
  }
  
  if (keywordMatches.length > 0) {
    console.log(`Found ${keywordMatches.length} keyword matches`);
    return keywordMatches.sort((a, b) => b.score - a.score).slice(0, 5);
  }
  
  return [];
}
// Improved GPT matching with better semantic understanding
async function gptMatchProducts(userMessage) {
  if (!openai || !process.env.OPENAI_API_KEY) {
    console.log('OpenAI not configured');
    return [];
  }
  
  try {
    // Prepare comprehensive product data for GPT
    const productsForGpt = productsData.slice(0, 200).map(product => ({
      id: product.id,
      name: product.name || '',
      tags: product.tagsArray || [],
      price: product.price || 0,
      category_hints: product.tagsArray ? product.tagsArray.join(', ') : ''
    }));
    
    const prompt = `
USER QUERY: "${userMessage}"

TASK: Find products that match the USER'S INTENT and MEANING, not just keywords.
1. Match based on SEMANTIC MEANING:
2. Use product TAGS as descriptors:
   - Tags describe color, style, occasion, material, etc.
   - Match the user's intent to relevant tags
3. Consider synonyms and related terms:

AVAILABLE PRODUCTS (first 200):
${JSON.stringify(productsForGpt, null, 2)}

RETURN TOP 5 MATCHES as JSON:
{
  "query_interpretation": "Brief explanation of what the user wants",
  "matched_products": [
    {
      "id": "product-id",
      "match_reason": "Why this matches the user's intent semantically",
      "confidence": 0.95
    }
  ]
}
    `;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",  // Using GPT-4 for better understanding
      messages: [
        { 
          role: "system", 
          content: `You are a product search expert. Understand the user's REAL intent and match products semantically, not just by keywords.
          Consider synonyms, context, and product attributes. Focus on what the user MEANS, not just what they SAY.` 
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.2
    });
    
    const content = completion.choices[0].message.content.trim();
    
    try {
      const parsed = JSON.parse(content);
      
      console.log(`🤖 GPT Query Interpretation: "${parsed.query_interpretation}"`);
      
      const matches = parsed.matched_products || [];
      
      // Convert to product format
      const matchedProducts = matches
        .map(gptMatch => {
          const product = productsData.find(p => p.id === gptMatch.id);
          if (!product) return null;
          
          return {
            id: product.id,
            name: product.name,
            price: product.price || null,
            image: product.image || null,
            tagsArray: product.tagsArray || [],
            score: gptMatch.confidence || 0.5,
            matchedFields: ['gpt_semantic'],
            gpt_reason: gptMatch.match_reason || '',
            query_interpretation: parsed.query_interpretation
          };
        })
        .filter(Boolean);
      
      return matchedProducts.slice(0, 5);
      
    } catch (parseError) {
      console.error('Error parsing GPT response:', parseError, 'Raw:', content.substring(0, 200));
      return [];
    }
    
  } catch (error) {
    console.error('GPT product matching error:', error);
    return [];
  }
}

async function findSellersForGallery(gallery, query) {
  if (!gallery || !sellersData.length) return [];
  
  console.log(`🔍 Finding sellers for gallery: ${gallery.type2 || gallery.name}`);
  
  const matchedSellers = [];
  
  sellersData.forEach(seller => {
    let score = 0;
    let matchReasons = [];
    
    // Priority 1: Direct store name match
    if (seller.store_name) {
      const storeName = seller.store_name.toLowerCase();
      
      // Match with gallery type2 (often store name)
      if (gallery.type2 && storeName.includes(gallery.type2.toLowerCase())) {
        score += 2.0;
        matchReasons.push(`Store name matches gallery type: "${gallery.type2}"`);
      }
      
      // Match with query terms
      const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      queryTerms.forEach(term => {
        if (storeName.includes(term) || smartSimilarity(storeName, term) > 0.8) {
          score += 1.0;
          matchReasons.push(`Store name matches query term: "${term}"`);
        }
      });
    }
    
    // Priority 2: Category matching
    if (seller.category_ids_array && gallery.catnameArray) {
      const commonCategories = seller.category_ids_array.filter(sellerCat =>
        gallery.catnameArray.some(galleryCat =>
          smartSimilarity(sellerCat, galleryCat) > 0.7
        )
      );
      
      if (commonCategories.length > 0) {
        score += (commonCategories.length * 0.5);
        matchReasons.push(`Shared categories: ${commonCategories.join(', ')}`);
      }
    }
    
    // Priority 3: Seller ID matching with gallery seller_id
    if (gallery.seller_id && seller.seller_id && 
        String(gallery.seller_id).trim() === String(seller.seller_id).trim()) {
      score += 3.0;
      matchReasons.push('Direct seller ID match');
    }
    
    if (score > 0.8) {
      matchedSellers.push({
        ...seller,
        score: score,
        matchReasons: matchReasons,
        galleryMatch: gallery.type2 || gallery.name
      });
    }
  });
  
  return matchedSellers
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
async function getEnhancedResponse(userMessage) {
  console.log(`🚀 Processing: "${userMessage}"`);
  
  // STEP 1: PRODUCT SEARCH (Highest Priority)
  console.log('📦 Step 1: Searching products...');
  const productMatches = await searchProductsForQuery(userMessage);
  
  // STEP 2: GALLERY SEARCH based on products found
  console.log('🏬 Step 2: Finding related galleries...');
  let galleryMatches = [];
  if (productMatches.length > 0) {
    // Get unique categories from product matches
    const productCategories = [];
    productMatches.forEach(p => {
      if (p.tagsArray) productCategories.push(...p.tagsArray);
    });
    
    // Find galleries matching these categories
    galleryMatches = findGalleriesByCategories(productCategories, userMessage);
  }
  
  // If no gallery matches found, try store name matching
  if (galleryMatches.length === 0) {
    galleryMatches = matchGalleriesByStoreName(userMessage, productMatches);
  }
  
  // STEP 3: SELLER SEARCH based on galleries
  console.log('👨‍💼 Step 3: Finding sellers...');
  let sellerMatches = [];
  if (galleryMatches.length > 0) {
    for (const gallery of galleryMatches.slice(0, 2)) {
      const sellers = await findSellersForGallery(gallery, userMessage);
      sellerMatches.push(...sellers);
    }
    
    // Remove duplicates
    sellerMatches = sellerMatches.filter((seller, index, self) =>
      index === self.findIndex(s => s.seller_id === seller.seller_id)
    );
  }
  
  // STEP 4: If still no results, try GPT-based matching
  if (productMatches.length === 0 && galleryMatches.length === 0) {
    console.log('🤖 Step 4: Using GPT for fallback matching...');
    return await gptFallbackMatching(userMessage);
  }
  
  // STEP 5: Build response
  return buildEnhancedResponse(userMessage, productMatches, galleryMatches, sellerMatches);
}

// Helper: Find galleries by product categories
function findGalleriesByCategories(categories, query) {
  if (!categories.length || !galleriesData.length) return [];
  
  const matchedGalleries = [];
  
  galleriesData.forEach(gallery => {
    let score = 0;
    let matchedCategories = [];
    
    // Check gallery categories
    if (gallery.catnameArray) {
      categories.forEach(cat => {
        gallery.catnameArray.forEach(gCat => {
          if (smartSimilarity(cat, gCat) > 0.7) {
            score += 1.0;
            matchedCategories.push(`${cat} → ${gCat}`);
          }
        });
      });
    }
    
    if (score > 0.5) {
      matchedGalleries.push({
        ...gallery,
        score: score,
        matchedCategories: matchedCategories
      });
    }
  });
  
  return matchedGalleries
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// GPT fallback matching
async function gptFallbackMatching(userMessage) {
  if (!openai) return buildConciseResponse(userMessage, [], {}, []);
  
  try {
    const prompt = `
    User is searching for: "${userMessage}"
    
    Please analyze this query and identify:
    1. Product type/category (e.g., clothing, electronics, home decor)
    2. Specific attributes (color, size, brand, material)
    3. Price range indicators
    4. Store/brand mentions
    
    Return in JSON format:
    {
      "product_category": "category name",
      "attributes": ["attr1", "attr2"],
      "price_hint": "optional price range",
      "store_mentions": ["store1", "store2"]
    }
    `;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 200
    });
    
    const analysis = JSON.parse(completion.choices[0].message.content);
    
    // Use analysis to search products
    const searchTerms = [
      analysis.product_category,
      ...analysis.attributes,
      ...analysis.store_mentions
    ].filter(Boolean).join(' ');
    
    if (searchTerms) {
      return await getEnhancedResponse(searchTerms);
    }
    
    return buildConciseResponse(userMessage, [], {}, []);
    
  } catch (error) {
    console.error('GPT fallback error:', error);
    return buildConciseResponse(userMessage, [], {}, []);
  }
}

// Enhanced response builder
function buildEnhancedResponse(query, products, galleries, sellers) {
  let responseText = `Based on your search for "${query}":\n\n`;
  
  if (products.length === 0 && galleries.length === 0) {
    responseText = `I couldn't find exact matches for "${query}". Here are some related suggestions:`;
    // Show popular products as fallback
    products = productsData.slice(0, 5);
  }
  
  const response = {
    type: 'enhanced',
    text: responseText,
    products: products.slice(0, 5).map(p => formatProduct(p)),
    galleries: galleries.slice(0, 3).map(g => formatGallery(g)),
    sellers: sellers.slice(0, 3).map(s => formatSeller(s)),
    stats: {
      productsFound: products.length,
      galleriesFound: galleries.length,
      sellersFound: sellers.length
    }
  };
  
  return response;
}

// Format product for response
function formatProduct(product) {
  return {
    id: product.id,
    name: product.name || 'Product',
    price: product.price || 'Price on request',
    image: product.image || 'https://via.placeholder.com/150x200/1a2733/ffffff?text=Product',
    link: product.id ? `https://app.zulu.club/featured/product?id=${product.id}` : '#',
    tags: product.tagsArray || [],
    matchScore: product.score || 0,
    matchDetails: product.matchDetails || []
  };
}

// Format gallery for response
function formatGallery(gallery) {
  return {
    id: gallery.id,
    name: gallery.type2 || gallery.name || 'Gallery',
    image: gallery.image1 || 'https://via.placeholder.com/150x200/1a2733/ffffff?text=Gallery',
    link: gallery.id ? `https://app.zulu.club/gallery/id=${gallery.id}` : '#',
    type: gallery.type2 || '',
    categories: gallery.catnameArray || [],
    isStore: gallery.isStore || false
  };
}

// Format seller for response
function formatSeller(seller) {
  return {
    id: seller.seller_id || seller.user_id,
    name: seller.store_name || 'Seller',
    link: seller.user_id ? `https://app.zulu.club/sellerassets/${seller.user_id}` : '#',
    categories: seller.category_ids_array || [],
    matchReasons: seller.matchReasons || []
  };
}
// Replace the existing buildConciseResponse function with this updated version:

function buildConciseResponse(userMessage, galleryMatches = [], sellersObj = {}, productMatches = []) {
  console.log('Building response with:', {
    productMatches: productMatches.length,
    galleryMatches: galleryMatches.length,
    sellersCount: sellersObj ? Object.keys(sellersObj).length : 0
  });
  
  // Prepare products data for response
  const products = productMatches.slice(0, 5).map((product, index) => {
    // Generate product link using product id
    let productLink = '';
    if (product.id) {
      // Clean the ID - remove any non-numeric characters
      const cleanId = String(product.id).replace(/[^\d]/g, '');
      if (cleanId) {
        productLink = `https://app.zulu.club/featured/product?id=${cleanId}`;
      }
    }
    
    // Handle price
    let priceDisplay = 'Price on request';
    
    // Check if price exists
    if (product.price !== undefined && product.price !== null) {
      console.log(`Processing price for product ${index}: ${product.price}`);
      
      // Try to convert to number - CSV me sirf numbers hain jaise "4"
      const priceValue = product.price;
      console.log(`Raw price value: ${priceValue}, Type: ${typeof priceValue}`);
      
      // If it's already a number
      if (typeof priceValue === 'number') {
        priceDisplay = `${priceValue}`;
        console.log(`Formatted from number: ${priceDisplay}`);
      }
      // If it's a string
      else if (typeof priceValue === 'string') {
        // Remove any non-numeric characters (just in case)
        const cleanedPrice = priceValue.replace(/[^\d.]/g, '');
        console.log(`Cleaned price string: ${cleanedPrice}`);
        
        if (cleanedPrice && !isNaN(parseFloat(cleanedPrice))) {
          const priceNum = parseFloat(cleanedPrice);
          priceDisplay = `${priceNum}`;
          console.log(`Formatted from string: ${priceDisplay}`);
        }
      }
    } else {
      console.log(`Product ${index} has no price or it's null/undefined`);
    }
    
    // Handle image URL
    let imageUrl = null;
    if (product.image && product.image.trim() !== '') {
      if (product.image.startsWith('/')) {
        imageUrl = `https://zulushop.in${product.image}`;
      } else if (product.image.startsWith('http')) {
        imageUrl = product.image;
      }
    }
    
    // Fallback image if none available
    if (!imageUrl) {
      imageUrl = 'https://via.placeholder.com/150x200/1a2733/ffffff?text=Product';
    }
    
    return {
      id: product.id || `product-${index}`,
      name: product.name || 'Product',
      price: priceDisplay,
      image: imageUrl,
      link: productLink,
      score: product.score || 0,
      matchedVia: product.matchedFields || [],
      gptReason: product.gpt_reason || ''  // Add this line
    };
  });
  
  // Prepare galleries data for response
  const galleries = galleryMatches.slice(0, 5).map((gallery, index) => {
    const galleryId = gallery.id || '';
    let link = '';
    
    if (galleryId) {
      link = `https://app.zulu.club/gallery/id=${galleryId}`;
    } else if (gallery.type2) {
      link = `https://app.zulu.club/${urlEncodeType2(gallery.type2)}`;
    } else if (gallery.name) {
      link = `https://app.zulu.club/${urlEncodeType2(gallery.name)}`;
    }
    
    let imageUrl = null;
    if (gallery.image1 && gallery.image1.trim() !== '') {
      if (gallery.image1.startsWith('/')) {
        imageUrl = `https://zulushop.in${gallery.image1}`;
      } else if (gallery.image1.startsWith('http')) {
        imageUrl = gallery.image1;
      }
    }
    
    if (!imageUrl) {
      imageUrl = 'https://via.placeholder.com/150x200/1a2733/ffffff?text=Gallery';
    }
    
    return {
      id: gallery.id || `gallery-${index}`,
      name: gallery.type2 || gallery.name || 'Gallery',
      link: link,
      image: imageUrl,
      type: gallery.type2 || '',
      category: gallery.cat1 || gallery.catname || gallery.cat1name || '',
      matchedFields: gallery.matchedFields || [],
      matchScore: gallery.score || 0
    };
  });
  
  // Prepare sellers data for response
  const sellersList = [];
  const addSeller = (s) => {
    if (!s) return;
    const id = s.user_id || s.seller_id || '';
    if (!id) return;
    if (!sellersList.some(x => (x.user_id || x.seller_id) === id)) sellersList.push(s);
  };
  
  (sellersObj.by_type2 || []).forEach(addSeller);
  (sellersObj.by_category || []).forEach(addSeller);
  (sellersObj.by_gpt || []).forEach(item => addSeller(item.seller));
  
  const sellers = sellersList.slice(0, 5).map((seller, index) => {
    const sellerId = seller.user_id || seller.seller_id || '';
    let sellerLink = '';
    
    if (sellerId) {
      sellerLink = `https://app.zulu.club/sellerassets/${sellerId}`;
    }
    
    return {
      id: sellerId || `seller-${index}`,
      name: seller.store_name || `Seller ${index + 1}`,
      link: sellerLink,
      categories: seller.category_ids_array || []
    };
  });
  
  // Create response text
  let textResponse = `Based on your search for "${userMessage}":\n\n`;
  
  if (products.length === 0 && galleries.length === 0 && sellers.length === 0) {
    textResponse += `No results found for "${userMessage}". Try searching with different keywords.`;
  }
  
  // Debug log
  console.log('Products for response:', products);
  
  // Return structured response
  return {
    type: 'structured',
    text: textResponse,
    products: products,
    galleries: galleries,
    sellers: sellers,
    query: userMessage
  };
}

async function findGptMatchedCategories(userMessage, conversationHistory = []) {
  try {
    const csvDataForGPT = galleriesData.map(item => ({
      id: item.id, // Add id to data sent to GPT
      type2: item.type2,
      cat1: item.cat1,
      cat_id: item.cat_id,
      name: item.name // Add name field
    }));
    
    const systemContent = "You are a product matching expert for Zulu Club. Use the conversation history to understand what the user wants, and return only JSON with top matches and a compact reasoning field. Prefer to use 'id' field for matching when available.";
    const messagesForGPT = [{ role: 'system', content: systemContent }];
    
    const historyToInclude = Array.isArray(conversationHistory) ? conversationHistory.slice(-30) : [];
    for (const h of historyToInclude) {
      const role = (h.role === 'assistant') ? 'assistant' : 'user';
      messagesForGPT.push({ role, content: h.content });
    }
    
    const userPrompt = `
Using the conversation above and the user's latest message, return the top 5 matching categories from the AVAILABLE PRODUCT CATEGORIES (use the "id" field when available, otherwise "type2" field). For each match return a short reason and a relevance score 0.0-1.0.

AVAILABLE PRODUCT CATEGORIES:
${JSON.stringify(csvDataForGPT, null, 2)}

USER MESSAGE: "${userMessage}"

RESPONSE FORMAT (JSON ONLY):
{
  "matches": [
    { 
      "id": "exact-id-value-from-csv", 
      "type2": "type2-value-from-csv",
      "reason": "brief explanation", 
      "score": 0.9 
    }
  ],
  "reasoning": "1-3 sentence summary of how you matched categories (brief steps)"
}
    `;
    
    messagesForGPT.push({ role: 'user', content: userPrompt });
    console.log(`🧾 findGptMatchedCategories -> sending ${messagesForGPT.length} messages to OpenAI (session history included).`);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messagesForGPT,
      max_tokens: 1000,
      temperature: 0.2
    });

    const responseText = completion.choices[0].message.content.trim();
    let matches = [];
    let reasoning = '';
    
    try {
      const parsed = JSON.parse(responseText);
      matches = parsed.matches || [];
      reasoning = parsed.reasoning || parsed.debug_reasoning || '';
    } catch (e) {
      console.error('Error parsing GPT product matches JSON:', e, 'raw:', responseText);
      matches = [];
      reasoning = responseText.slice(0, 300);
    }
    
    const matchedCategories = matches
      .map(match => {
        // Try to find by id first, then by type2
        if (match.id) {
          return galleriesData.find(item => String(item.id).trim() === String(match.id).trim());
        } else if (match.type2) {
          return galleriesData.find(item => String(item.type2).trim() === String(match.type2).trim());
        }
        return null;
      })
      .filter(Boolean)
      .slice(0,5);

    matchedCategories._reasoning = reasoning;
    return matchedCategories;
  } catch (error) {
    console.error('Error in findGptMatchedCategories:', error);
    return [];
  }
}
async function classifyAndMatchWithGPT(userMessage) {
  const text = (userMessage || '').trim();
  if (!text) {
    return { intent: 'company', confidence: 1.0, reason: 'empty message', matches: [], reasoning: '' };
  }
  
  if (!openai || !process.env.OPENAI_API_KEY) {
    return { intent: 'company', confidence: 0.0, reason: 'OpenAI not configured', matches: [], reasoning: '' };
  }
  
  // Include id in the data sent to GPT
  const csvDataForGPT = galleriesData.map(item => ({ 
    id: item.id, 
    type2: item.type2, 
    cat1: item.cat1, 
    cat_id: item.cat_id,
    name: item.name 
  }));
  
  const prompt = `
You are an assistant for Zulu Club (a lifestyle shopping service).

Task:
1) Decide the user's intent. Choose exactly one of: "company", "product", "seller", "investors", "agent", "voice_ai".
   - "company": general questions, greetings, store info, pop-ups, support, availability, delivery, services.
   - "product": the user is asking to browse or buy items, asking what we have, searching for products/categories.
   - "seller": queries about selling on the platform, onboarding merchants.
   - "investors": questions about business model, revenue, funding, pitch, investment.
   - "agent": the user explicitly asks to connect to a human/agent/representative, or asks for a person to contact them.
   - "voice_ai": the user is asking for an AI-made song, AI music message, custom voice AI output, goofy/personalised audio, etc.

2) If the intent is "product", pick up to 5 best-matching categories from the AVAILABLE CATEGORIES list provided. Use "id" field when available.

3) Return ONLY valid JSON in this exact format (no extra text):
{
  "intent": "product",
  "confidence": 0.0,
  "reason": "short explanation for the chosen intent",
  "matches": [
    { 
      "id": "exact-id-from-csv", 
      "type2": "exact-type2-from-csv", 
      "reason": "why it matches", 
      "score": 0.85 
    }
  ],
  "reasoning": "1-3 sentence concise explanation of the steps you took to decide (brief chain-of-thought)"
}

If intent is not "product", return "matches": [].

AVAILABLE CATEGORIES:
${JSON.stringify(csvDataForGPT, null, 2)}

USER MESSAGE:
"""${String(userMessage).replace(/"/g, '\\"')}
"""
  `;
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a JSON-only classifier & category matcher. Return only the requested JSON, including a short 'reasoning' field." },
        { role: "user", content: prompt }
      ],
      max_tokens: 900,
      temperature: 0.12
    });
    
    const raw = (completion.choices && completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content) ? completion.choices[0].message.content.trim() : '';
    
    try {
      const parsed = JSON.parse(raw);
      const allowedIntents = ['company', 'product', 'seller', 'investors', 'agent', 'voice_ai'];
      const intent = (parsed.intent && allowedIntents.includes(parsed.intent)) ? parsed.intent : 'company';
      const confidence = Number(parsed.confidence) || 0.0;
      const reason = parsed.reason || '';
      const matches = Array.isArray(parsed.matches) ? parsed.matches.map(m => ({ 
        id: m.id, 
        type2: m.type2, 
        reason: m.reason, 
        score: Number(m.score) || 0 
      })) : [];
      const reasoning = parsed.reasoning || parsed.debug_reasoning || '';
      
      console.log('🧾 classifyAndMatchWithGPT parsed:', { raw, parsed, intent, confidence });
      return { intent, confidence, reason, matches, reasoning };

    } catch (e) {
      console.error('Error parsing classifyAndMatchWithGPT JSON:', e, 'raw:', raw);
      return { intent: 'company', confidence: 0.0, reason: 'parse error from GPT', matches: [], reasoning: raw.slice(0, 300) };
    }
  } catch (err) {
    console.error('Error calling OpenAI classifyAndMatchWithGPT:', err);
    return { intent: 'company', confidence: 0.0, reason: 'gpt error', matches: [], reasoning: '' };
  }
}

function isGreeting(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase().trim();
  
  const greetings = ['hi', 'hello', 'hey', 'good morning', 'good evening', 'good afternoon', 'greetings', 'namaste', 'namaskar' , 'hola', 'hey there'];
  const cleaned = t.replace(/[^\w\s]/g, '').trim();
  if (greetings.includes(cleaned)) return true;
  if (/^hi+$/i.test(cleaned)) return true;
  if (greetings.some(g => cleaned === g)) return true;
  
  return false;
}

async function generateCompanyResponse(userMessage, conversationHistory, companyInfo = ZULU_CLUB_INFO) {
  const messages = [];

  const systemMessage = {
    role: "system",
    content: `You are a friendly and helpful customer service assistant for Zulu Club, a premium lifestyle shopping service. 

    ZULU CLUB INFORMATION:
    ${companyInfo}

    IMPORTANT RESPONSE GUIDELINES:
    1. Keep responses conversational and helpful
    2. Highlight key benefits: 100-minute delivery, try-at-home, easy returns
    3. Mention availability: Currently in Gurgaon, pop-ups at M3M Urbana Market, AIPL Joy Street Market, AIPL Joy Central Market, Zulu Club Experience Store — Shop 9, M3M Urbana Premium, Sector 67, Gurgaon
    4. Use emojis to make it engaging but professional
    5. Keep responses under 200 characters for WhatsApp compatibility
    6. Be enthusiastic and helpful 
    7. Direct users to our website zulu.club for more information and shopping
    `
  };
  
  messages.push(systemMessage);
  
  if (conversationHistory && conversationHistory.length > 0) {
    const recentHistory = conversationHistory.slice(-6);
    recentHistory.forEach(msg => {
      if (msg.role && msg.content) {
        messages.push({
          role: msg.role,
          content: msg.content
        });
      }
    });
  }
  
  messages.push({
    role: "user",
    content: userMessage
  });
  
  const LINKS_BLOCK = [
    "*iOS:*",
    "https://apps.apple.com/in/app/zulu-club/id6739531325",
    "*Android:*",
    "https://play.google.com/store/apps/details?id=com.zulu.consumer.zulu_consumer"
  ].join("\n");
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      max_tokens: 300,
      temperature: 0.6
    });
    
    let assistantText = (completion.choices[0].message && completion.choices[0].message.content)
      ? completion.choices[0].message.content.trim()
      : "";
    
    if (!isGreeting(userMessage)) {
      if (assistantText.length > 0) assistantText = assistantText + "\n\n" + LINKS_BLOCK;
      else assistantText = LINKS_BLOCK;
    }
    
    return assistantText;
  } catch (e) {
    console.error('Error in generateCompanyResponse:', e);
    let fallback = `Hi! We're Zulu Club — shop at zulu.club or visit our pop-ups in Gurgaon.`;
    if (!isGreeting(userMessage)) {
      fallback = `${fallback}\n\n${LINKS_BLOCK}`;
    }
    return fallback;
  }
}

async function generateInvestorResponse(userMessage) {
  const prompt = `
You are an **Investor Relations Associate** for Zulu (MAD MIND TECH INNOVATIONS PVT LTD).

Use ONLY this factual data when answering:
${INVESTOR_KNOWLEDGE}

Rules:
• Respond directly to the user's question: "${userMessage}"
• Respond in Hinglish language or Hindi language according to "${userMessage}" based totally on user message language
• Strong, authoritative IR tone (no over-selling)
• Include relevant metrics: funding, founders, growth stage, HQ, legal info according to user's question: "${userMessage}"
• Max 200 characters (2–4 sentences)
• Avoid emojis inside the explanation
• Do not mention "paragraph above" or internal sources
• If user asks broad or unclear query → Give concise Zulu overview

At the end, always add a separate CTA line:
Apply to invest 👉 https://forms.gle/5wwfYFB7gGs75pYq5
  `;
  
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 500,
    temperature: 0.3
  });
  
  return res.choices[0].message.content.trim();
}

async function generateSellerResponse(userMessage) {
  const prompt = `
You are a **Brand Partnerships | Seller Success Associate** at Zulu Club.

Use ONLY this factual data when answering:
${SELLER_KNOWLEDGE}

Rules:
• Respond specifically to the seller's question: "${userMessage}"
• Respond in Hinglish language or Hindi language according to "${userMessage}" based totally on user message language
• Highlight benefits that match their intent (reach, logistics, onboarding, customers) according to user's question: "${userMessage}"
• Premium but friendly business tone
• Max 200 characters (2–4 sentences)
• Avoid emojis inside explanation
• Avoid generic copywriting style

Add this CTA as a new line at the end:
Join as partner 👉 https://forms.gle/tvkaKncQMs29dPrPA
  `;
  
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 500,
    temperature: 0.35
  });
  
  return res.choices[0].message.content.trim();
}

// Session/history helpers
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const SESSION_CLEANUP_MS = 1000 * 60 * 5; // 5 minutes
const MAX_HISTORY_MESSAGES = 2000;

function nowMs() { return Date.now(); }

function createOrTouchSession(sessionId, isAuthenticated = false) {
  console.log(`📝 createOrTouchSession: ${sessionId}, isAuthenticated: ${isAuthenticated}`);
  
  if (!conversations[sessionId]) {
    conversations[sessionId] = {
      history: [],
      lastActive: nowMs(),
      lastDetectedIntent: null,
      lastDetectedIntentTs: 0,
      lastMedia: null,
      isAuthenticated: isAuthenticated
    };
    console.log(`Created new session: ${sessionId}`);
  } else {
    conversations[sessionId].lastActive = nowMs();
    conversations[sessionId].isAuthenticated = isAuthenticated || conversations[sessionId].isAuthenticated;
    console.log(`Updated existing session: ${sessionId}`);
  }
  
  return conversations[sessionId];
}

function appendToSessionHistory(sessionId, role, content) {
  console.log(`📝 appendToSessionHistory: ${sessionId}, role: ${role}, content length: ${content.length}`);
  
  // Ensure session exists
  if (!conversations[sessionId]) {
    console.log(`🔄 Session ${sessionId} not found, creating it...`);
    createOrTouchSession(sessionId, false);
  }
  
  const entry = { role, content, ts: nowMs() };
  conversations[sessionId].history.push(entry);
  
  if (conversations[sessionId].history.length > MAX_HISTORY_MESSAGES) {
    conversations[sessionId].history = conversations[sessionId].history.slice(-MAX_HISTORY_MESSAGES);
  }
  
  conversations[sessionId].lastActive = nowMs();
  console.log(`History updated for ${sessionId}, total messages: ${conversations[sessionId].history.length}`);
}

function getFullSessionHistory(sessionId) {
  const s = conversations[sessionId];
  if (!s || !s.history) {
    console.log(`No history found for session: ${sessionId}`);
    return [];
  }
  return s.history.slice();
}

function purgeExpiredSessions() {
  const cutoff = nowMs() - SESSION_TTL_MS;
  const before = Object.keys(conversations).length;
  
  for (const id of Object.keys(conversations)) {
    if (!conversations[id].lastActive || conversations[id].lastActive < cutoff) {
      delete conversations[id];
    }
  }
  
  const after = Object.keys(conversations).length;
  if (before !== after) console.log(`🧹 Purged ${before - after} expired sessions`);
}

setInterval(purgeExpiredSessions, SESSION_CLEANUP_MS);

function recentHistoryContainsProductSignal(conversationHistory = []) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return null;
  
  const productKeywords = ['tshirt','t-shirt','shirt','tee','jeans','pant','pants','trouser','kurta','lehenga','top','dress','saree','innerwear','jacket','sweater','shorts','tshir','t shrt'];
  const recentUserMsgs = conversationHistory.slice(-10).filter(m => m.role === 'user').map(m => (m.content || '').toLowerCase());
  
  for (const msg of recentUserMsgs) {
    for (const pk of productKeywords) {
      if (msg.includes(pk)) return true;
    }
  }
  
  return false;
}

async function getChatGPTResponse(sessionId, userMessage, isAuthenticated = false) {
  if (!process.env.OPENAI_API_KEY) {
    return "Hello! I'm here to help you with Zulu Club. Currently, I'm experiencing technical difficulties. Please visit zulu.club for assistance.";
  }
  
  try {
    // ensure session exists
    createOrTouchSession(sessionId, isAuthenticated);
    const session = conversations[sessionId];
    
    // Check employee mode with suffix logic (only for authenticated users)
    if (isAuthenticated && sessionId.match(/^\d{10}[AU]?$/)) {
      const basePhone = sessionId.replace(/[A-Za-z]$/, '');
      const isEmployee = EMPLOYEE_NUMBERS.includes(basePhone);
      const suffix = /[A-Za-z]$/.test(sessionId) ? sessionId.slice(-1).toUpperCase() : '';
      
      console.log(`🔍 Employee check: ${sessionId} -> base: ${basePhone}, isEmployee: ${isEmployee}, suffix: ${suffix}`);
      
      if (isEmployee) {
        console.log("⚡ Employee detected, checking mode...");
        
        // If suffix is 'U', treat as user (bypass employee flow)
        if (suffix === 'U') {
          console.log("👤 User mode (suffix U) - bypassing employee flow");
        } 
        // If suffix is 'A' or no suffix, treat as admin/employee
        else if (suffix === 'A' || suffix === '') {
          console.log("👔 Admin/Employee mode activated, calling preIntentFilter");
          
          // Process through preIntentFilter for employee messages
          const employeeHandled = await preIntentFilter(
            openai,
            session,
            sessionId,
            userMessage,
            getSheets,
            createAgentTicket,
            appendUnderColumn
          );
          
          console.log(`📊 preIntentFilter returned: ${employeeHandled ? 'handled' : 'not handled'}`);
          
          // If preIntentFilter returned a response (not null), use it
          if (employeeHandled !== null && employeeHandled !== undefined && employeeHandled.trim().length > 0) {
            return employeeHandled;
          }
          
          // If preIntentFilter returned null/empty, continue with normal flow
          console.log("🔄 Employee mode but preIntentFilter returned null, continuing with normal flow");
        }
      }
    }
    
    // 1) classify only the single incoming message
    const classification = await classifyAndMatchWithGPT(userMessage);
    let intent = classification.intent || 'company';
    let confidence = classification.confidence || 0;
    
    console.log('🧠 GPT classification:', { intent, confidence, reason: classification.reason });
    
    // 2) Check if unauthenticated user is trying to access restricted intents
    if (!isAuthenticated && !['company', 'product'].includes(intent)) {
      return `To use this feature, please verify your phone number. Click the 'Verify' button to get started.`;
    }
    
    // 3) Set session intent
    if (intent === 'product') {
      session.lastDetectedIntent = 'product';
      session.lastDetectedIntentTs = nowMs();
    }
    
    // 4) Handle agent intent (only for authenticated users)
    if (intent === 'agent') {
      session.lastDetectedIntent = 'agent';
      session.lastDetectedIntentTs = nowMs();
      
      const fullHistory = getFullSessionHistory(sessionId);
      let ticketId = '';
      
      try {
        ticketId = await createAgentTicket(sessionId, fullHistory);
      } catch (e) {
        console.error('Error creating agent ticket:', e);
        ticketId = generateTicketId();
      }
      
      try {
        // Only log to Google Sheets for authenticated users
        if (isAuthenticated) {
          await appendUnderColumn(sessionId, `AGENT_TICKET_CREATED: ${ticketId}`);
        }
      } catch (e) {
        console.error('Failed to log agent ticket into column:', e);
      }
      
      return `Our representative will connect with you soon (within 30 mins). Your ticket id: ${ticketId}`;
    }
    
    if (intent === 'voice_ai') {
      session.lastDetectedIntent = 'voice_ai';
      session.lastDetectedIntentTs = nowMs();
      
      return `🎵 *Custom AI Music Message (Premium Add-on)*

For every gift above ₹1,000:
• You give a fun/emotional dialogue or a voice note  
• We turn it into a goofy or personalised AI song  
• Delivered within *2 hours* on WhatsApp  
• Adds emotional value & boosts the gifting impact ❤️

For more details, please contact our support team.`;
    }
    
    // 5) Handle other intents (only for authenticated users)
    if (intent === 'seller') {
      session.lastDetectedIntent = 'seller';
      session.lastDetectedIntentTs = nowMs();
      return await generateSellerResponse(userMessage);
    }
    
    if (intent === 'investors') {
      session.lastDetectedIntent = 'investors';
      session.lastDetectedIntentTs = nowMs();
      return await generateInvestorResponse(userMessage);
    }
    
// In the getChatGPTResponse function, update the product intent section:
if (intent === 'product' && (galleriesData.length > 0 || productsData.length > 0)) {
  if (session.lastDetectedIntent !== 'product') {
    session.lastDetectedIntent = 'product';
    session.lastDetectedIntentTs = nowMs();
  }
  
  const enhancedResponse = await getEnhancedResponse(userMessage);
  const keywordMatches = matchGalleriesByAllFields(userMessage);
  const matchedIds = (classification.matches || []).map(m => m.id).filter(Boolean);
  const matchedType2s = (classification.matches || []).map(m => m.type2).filter(Boolean);
  let matchedCategories = [];
  
  if (keywordMatches.length > 0) {
    matchedCategories = keywordMatches;
  } else {
    // Fallback to the original matching
    matchedCategories = findKeywordMatchesInCat1(userMessage);
  }
  
  if (matchedIds.length > 0) {
    matchedCategories = matchedIds
      .map(id => galleriesData.find(g => String(g.id).trim() === String(id).trim()))
      .filter(Boolean);
  }
  
  if (matchedCategories.length === 0 && matchedType2s.length > 0) {
    matchedCategories = matchedType2s
      .map(t => galleriesData.find(g => String(g.type2).trim() === String(t).trim()))
      .filter(Boolean)
      .slice(0,5);
  }
  
  if (matchedCategories.length === 0) {
    const fullHistory = getFullSessionHistory(sessionId);
    matchedCategories = await findGptMatchedCategories(userMessage, fullHistory);
  } else {
    const fullHistory = getFullSessionHistory(sessionId);
    const isShortOrQualifier = (msg) => {
      if (!msg) return false;
      const trimmed = String(msg).trim();
      if (trimmed.split(/\s+/).length <= 3) return true;
      if (trimmed.length <= 12) return true;
      return false;
    };
    
    if (isShortOrQualifier(userMessage)) {
      const refined = await findGptMatchedCategories(userMessage, fullHistory);
      if (refined && refined.length > 0) matchedCategories = refined;
    }
  }
  
  if (matchedCategories.length === 0) {
    if (containsClothingKeywords(userMessage)) {
      const fullHistory = getFullSessionHistory(sessionId);
      matchedCategories = await findGptMatchedCategories(userMessage, fullHistory);
    } else {
      const keywordMatches = findKeywordMatchesInCat1(userMessage);
      if (keywordMatches.length > 0) {
        matchedCategories = keywordMatches;
      } else {
        const fullHistory = getFullSessionHistory(sessionId);
        matchedCategories = await findGptMatchedCategories(userMessage, fullHistory);
      }
    }
  }
  
  const detectedGender = inferGenderFromCategories(matchedCategories);
  const sellers = await findSellersForQuery(userMessage, matchedCategories, detectedGender);
  
  const products = await searchProductsForQuery(userMessage); 

  return buildConciseResponse(userMessage, matchedCategories, sellers, products);
  return enhancedResponse;
}
    
    // Default: company response
    return await generateCompanyResponse(userMessage, getFullSessionHistory(sessionId), companyInfo = ZULU_CLUB_INFO);
    
  } catch (error) {
    console.error('getChatGPTResponse error:', error);
    return `Sorry, I encountered an error. Please try again.`;
  }
}

// Replace the existing handleMessage function with this:

async function handleMessage(sessionId, userMessage, isAuthenticated = false) {
  try {
    // Add validation for sessionId
    if (!sessionId) {
      console.error('handleMessage called with undefined sessionId');
      throw new Error('Session ID is required');
    }
    
    console.log(`🔵 handleMessage called with sessionId: ${sessionId}, isAuthenticated: ${isAuthenticated}`);
    
    // 1) Save incoming user message to session
    appendToSessionHistory(sessionId, 'user', userMessage);
    
    // 2) Log user message to Google Sheets (only for authenticated users)
    if (isAuthenticated && sessionId.match(/^\d{10}[AU]?$/)) {
      try {
        await appendUnderColumn(sessionId, `USER: ${userMessage}`);
      } catch (e) {
        console.error('sheet log user failed', e);
      }
    }
    
    // 3) Debug print compact history
    const fullHistory = getFullSessionHistory(sessionId);
    console.log(`🔁 Session ${sessionId} history length: ${fullHistory.length}, Authenticated: ${isAuthenticated}`);
    
    // 4) Get response
    const aiResponse = await getChatGPTResponse(sessionId, userMessage, isAuthenticated);
    
    // 5) Check if response is structured (for products) or plain text
    let finalResponse;
    let responseType = 'text';
    let responseText;

    if (aiResponse && typeof aiResponse === 'object' && aiResponse.type === 'structured') {
      // Structured response for products
      finalResponse = aiResponse;
      responseType = 'structured';
      responseText = aiResponse.text;
    } else {
      // Plain text response for other intents
      finalResponse = {
        type: 'text',
        text: aiResponse
      };
      responseText = aiResponse;
    }
    
    // 6) Save AI response back into session history
    appendToSessionHistory(sessionId, 'assistant', responseText);
    
    // 7) Log assistant response (only for authenticated users)
    if (isAuthenticated && sessionId.match(/^\d{10}[AU]?$/)) {
      try {
        await appendUnderColumn(sessionId, `ASSISTANT: ${responseText}`);
      } catch (e) {
        console.error('sheet log assistant failed', e);
      }
    }
    
    // 8) update lastActive
    if (conversations[sessionId]) conversations[sessionId].lastActive = nowMs();
    
    // 9) return the assistant reply with type information
    return {
      success: true,
      response: finalResponse,
      responseType: responseType,
      timestamp: new Date().toISOString(),
      isAuthenticated: isAuthenticated,
      sessionId: sessionId
    };
  } 
  catch (error) {
    console.error('Error handling message:', error);
    return {
      success: false,
      response: {
        type: 'text',
        text: 'Sorry, I encountered an error. Please try again.'
      },
      responseType: 'text',
      timestamp: new Date().toISOString(),
      isAuthenticated: isAuthenticated,
      sessionId: sessionId
    };
  }
}

/**
 * Send OTP to phone number
 */
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    console.log(`📱 Sending OTP to: ${phoneNumber}`);
    
    const result = await sendOtp(phoneNumber);
    
    return res.json({
      success: true,
      message: 'OTP sent successfully',
      phoneNumber,
      requestId: result.request_id,
      debugOtp: result.debugOtp // Only for development
    });
    
  } catch (error) {
    console.error('Error sending OTP:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP'
    });
  }
});

/**
 * Verify OTP
 */
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phoneNumber, otp } = req.body;
    
    if (!phoneNumber || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Phone number and OTP are required'
      });
    }

    console.log(`Verifying OTP for: ${phoneNumber}`);
    
    const result = await verifyOtp(phoneNumber, otp);
    
    return res.json({
      success: true,
      message: 'OTP verified successfully',
      phoneNumber,
      isAdmin: result.isAdmin,
      verified: true
    });
    
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Invalid OTP'
    });
  }
});

/**
 * Check verification status
 */
app.post('/auth/check-status', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    const user = verifiedUsers[phoneNumber];
    
    if (!user || !user.verified) {
      return res.json({
        success: true,
        verified: false,
        message: 'User not verified'
      });
    }

    return res.json({
      success: true,
      verified: true,
      isAdmin: user.isAdmin,
      verifiedAt: user.verifiedAt,
      phoneNumber
    });
    
  } catch (error) {
    console.error('Error checking status:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Logout/remove verification
 */
app.post('/auth/logout', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    if (verifiedUsers[phoneNumber]) {
      delete verifiedUsers[phoneNumber];
      console.log(`👋 User ${phoneNumber} logged out`);
    }

    return res.json({
      success: true,
      message: 'Logged out successfully'
    });
    
  } catch (error) {
    console.error('Error logging out:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// -------------------------
// Chat API Endpoints
// -------------------------

// Serve chat interface
app.get('/chat', (req, res) => {
  res.sendFile(__dirname + '/chat.html');
});

// Update the /chat/message endpoint
app.post('/chat/message', checkAuthentication, async (req, res) => {
  try {
    const sessionId = req.sessionId;
    const isAuthenticated = req.isAuthenticated;
    const { message } = req.body;
    
    console.log(`Chat message from ${sessionId} (Authenticated: ${isAuthenticated}): ${message}`);
    
    if (!sessionId) {
      console.error('sessionId is undefined in /chat/message endpoint');
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }
    
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Message is required'
      });
    }
    
    // Process the message using handleMessage which now returns structured data
    const result = await handleMessage(sessionId, message, isAuthenticated);
    
    // Return the response
    return res.json(result);
    
  } catch (error) {
    console.error('Chat API error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create unauthenticated session
app.post('/chat/create-session', (req, res) => {
  try {
    // Generate unique session ID for unauthenticated user
    const sessionId = 'guest-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    
    // Create session
    createOrTouchSession(sessionId, false);
    
    console.log(`Created unauthenticated session: ${sessionId}`);
    
    return res.json({
      success: true,
      sessionId: sessionId,
      message: 'Session created',
      isAuthenticated: false
    });
    
  } catch (error) {
    console.error('Error creating session:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Also update the /chat/history/:sessionId endpoint to handle missing sessions:
// Get chat history for a session
app.get('/chat/history/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    console.log(`Getting history for session: ${sessionId}`);
    
    let session = conversations[sessionId];
    let isAuthenticated = false;
    
    // If session doesn't exist but it's a guest session, create it
    if (!session && sessionId.startsWith('guest-')) {
      console.log(`Session ${sessionId} not found, creating new guest session`);
      session = createOrTouchSession(sessionId, false);
    }
    
    if (session) {
      isAuthenticated = session.isAuthenticated;
      const history = getFullSessionHistory(sessionId);
      
      console.log(`Session ${sessionId} exists, history length: ${history.length}, authenticated: ${isAuthenticated}`);
      
      return res.json({
        success: true,
        history: history,
        sessionActive: true,
        isAuthenticated: isAuthenticated
      });
    } else if (sessionId.match(/^\d{10}[AU]?$/)) {
      // If it's a phone number but not in conversations, create a session
      console.log(`🔄 Phone session ${sessionId} not found, creating new one`);
      session = createOrTouchSession(sessionId, false);
      const history = getFullSessionHistory(sessionId);
      
      return res.json({
        success: true,
        history: history,
        sessionActive: true,
        isAuthenticated: false
      });
    } else {
      console.log(`Session ${sessionId} not found and is not a guest session or phone number`);
      return res.status(400).json({
        success: false,
        error: 'Invalid session'
      });
    }
    
  } catch (error) {
    console.error('Chat history error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// -------------------------
// New Database Endpoints
// -------------------------
app.get('/api/categories', async (req, res) => {
  try {
    const data = await db.getCachedData('categories');
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update categories record
app.put('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Remove id from update data if present
    delete updateData.id;
    
    const result = await db.executeUpdate('categories', id, updateData);
    
    res.json({
      success: true,
      message: 'Category updated successfully',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    console.error('Update categories error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single categories record
app.get('/api/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const record = await db.getRecordById('categories', id);
    
    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Category record not found'
      });
    }
    
    res.json({
      success: true,
      data: record
    });
  } catch (error) {
    console.error('Get categories record error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Add categories to the clear-cache endpoint
app.post('/api/clear-cache/:type', (req, res) => {
  const { type } = req.params;
  
  if (type === 'all') {
    db.clearAllCaches();
    res.json({ success: true, message: 'All caches cleared' });
  } else if (['products', 'sellers', 'videos', 'users', 'galleries', 'appconfigs', 'categories'].includes(type)) {
    db.clearCache(type);
    res.json({ success: true, message: `Cache cleared for ${type}` });
  } else {
    res.status(400).json({ success: false, error: 'Invalid cache type' });
  }
});
// Get product stats by updater
app.get('/api/product-stats-by-updater', async (req, res) => {
  try {
    const data = await db.getProductStatsByUpdater();
    
    res.json({
      success: true,
      data: data,
      count: data.length,
      lastUpdated: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching product stats by updater:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Refresh database connection
app.post('/api/refresh-connection', (req, res) => {
  try {
    if (refreshConnection) {
      refreshConnection();
      res.json({ 
        success: true, 
        message: 'Database connection refreshed successfully' 
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Connection refresh function not available' 
      });
    }
  } catch (error) {
    console.error('Error refreshing connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Close database connection
app.post('/api/close-connection', (req, res) => {
  try {
    if (closeConnectionPool) {
      closeConnectionPool();
      res.json({ 
        success: true, 
        message: 'Database connection closed successfully' 
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Connection close function not available' 
      });
    }
  } catch (error) {
    console.error('Error closing connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create database connection
app.post('/api/create-connection', (req, res) => {
  try {
    if (createConnectionPool) {
      createConnectionPool();
      res.json({ 
        success: true, 
        message: 'Database connection created successfully' 
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Connection create function not available' 
      });
    }
  } catch (error) {
    console.error('Error creating connection:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Get products data
app.get('/api/products', async (req, res) => {
  try {
    const data = await db.getCachedData('products'); 
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/appconfigs', async (req, res) => {
  try {
    const data = await db.getAppConfigsData();
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching app configs:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Update appconfigs record
app.put('/api/appconfigs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Remove id from update data if present
    delete updateData.id;
    
    const result = await db.executeUpdate('appconfigs', id, updateData);
    
    res.json({
      success: true,
      message: 'App config updated successfully',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    console.error('Update appconfigs error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get single appconfigs record
app.get('/api/appconfigs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const record = await db.getRecordById('appconfigs', id);
    
    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'App config record not found'
      });
    }
    
    res.json({
      success: true,
      data: record
    });
  } catch (error) {
    console.error('Get appconfigs record error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/galleries', async (req, res) => {
  try {
    const data = await db.getCachedData('galleries');
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching galleries:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Get sellers data
app.get('/api/sellers', async (req, res) => {
  try {
    const data = await db.getCachedData('sellers');
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching sellers:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get videos data
app.get('/api/videos', async (req, res) => {
  try {
    const data = await db.getCachedData('videos');
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get users data
app.get('/api/users', async (req, res) => {
  try {
    const data = await db.getCachedData('users');
    
    res.json({
      success: true,
      data: data,
      count: data.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Clear specific cache
app.post('/api/clear-cache/:type', (req, res) => {
  const { type } = req.params;
  
  if (type === 'all') {
    db.clearAllCaches();  // Changed from dbFunctions
    res.json({ success: true, message: 'All caches cleared' });
  } else if (['products', 'sellers', 'videos', 'users', 'galleries'].includes(type)) {
    db.clearCache(type);  // Changed from dbFunctions
    res.json({ success: true, message: `Cache cleared for ${type}` });
  } else {
    res.status(400).json({ success: false, error: 'Invalid cache type' });
  }
});

// Get cache status
app.get('/api/cache-status', (req, res) => {
  const status = db.getAllCacheStatus();  // Changed from dbFunctions
  res.json({
    success: true,
    cacheStatus: status
  });
});

// Enhanced videos endpoint with category names
app.get('/api/videosenhanced', async (req, res) => {
  try {
    // Get all necessary data
    const videos = await db.getCachedData('videos');
    const categories = await db.getCachedData('categories');
    const sellers = await db.getCachedData('sellers');
    
    // Create lookup maps
    const categoryMap = {};
    categories.forEach(cat => {
      categoryMap[cat.id] = {
        name: cat.name,
        parent_id: cat.parent_id
      };
    });
    
    const sellerMap = {};
    sellers.forEach(seller => {
      sellerMap[seller.user_id] = seller.store_name;
    });
    
    // Enhance videos with names and process sub_sub_category
    const enhancedVideos = videos.map(video => {
      // Get main category name
      const categoryInfo = categoryMap[video.category_id];
      const categoryName = categoryInfo ? categoryInfo.name : '';
      
      // Get seller name
      const sellerName = sellerMap[video.seller_id] || '';
      
      // Process sub_sub_category (could be JSON array, comma-separated, or single value)
      let subCategoryIds = [];
      let subCategoryNames = [];
      
      if (video.sub_sub_category) {
        try {
          // Try to parse as JSON array
          const parsed = JSON.parse(video.sub_sub_category);
          if (Array.isArray(parsed)) {
            subCategoryIds = parsed.map(id => String(id).trim());
          } else if (typeof parsed === 'string') {
            subCategoryIds = parsed.split(',').map(id => String(id).trim());
          } else if (typeof parsed === 'number') {
            subCategoryIds = [String(parsed)];
          }
        } catch (e) {
          // If not JSON, try comma-separated or single value
          const strVal = String(video.sub_sub_category);
          if (strVal.includes(',')) {
            subCategoryIds = strVal.split(',').map(id => String(id).trim());
          } else {
            subCategoryIds = [strVal.trim()];
          }
        }
        
        // Get names for sub categories
        subCategoryNames = subCategoryIds.map(id => {
          const cat = categories.find(c => String(c.id) === id);
          return cat ? cat.name : `Sub Cat ${id}`;
        });
      }
      
      return {
        ...video,
        id: video.id,
        category_name: categoryName,
        seller_name: sellerName,
        sub_category_ids: subCategoryIds,
        sub_category_names: subCategoryNames,
        sub_category_display: subCategoryNames.join(', '),
        status_display: video.status == 1 ? 'Active' : 'Inactive',
        priority_display: video.priority ? `P${video.priority}` : 'P1',
        has_thumbnail: !!video.thumbnail,
        thumbnail_url: video.thumbnail ? getFullMediaUrl(video.thumbnail) : ''
      };
    });
    
    res.json({
      success: true,
      data: enhancedVideos,
      categories: categories,
      sellers: sellers,
      count: enhancedVideos.length
    });
  } catch (error) {
    console.error('Error fetching enhanced videos:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper function for media URLs
function getFullMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return `https://zulushop.in${url}`;
  return `https://zulushop.in/${url}`;
}

// Thumbnail upload endpoint (keep existing)
app.post('/api/videos/:id/upload-thumbnail', async (req, res) => {
  try {
    const { id } = req.params;
    const { thumbnailUrl } = req.body;
    
    if (!thumbnailUrl) {
      return res.status(400).json({
        success: false,
        error: 'Thumbnail URL is required'
      });
    }
    
    const updateData = {
      thumbnail: thumbnailUrl
    };
    
    const result = await db.executeUpdate('videos', id, updateData);
    
    res.json({
      success: true,
      message: 'Thumbnail updated successfully',
      data: {
        id: id,
        thumbnail: thumbnailUrl
      }
    });
    
  } catch (error) {
    console.error('Thumbnail upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Also add direct video update endpoint
app.put('/api/videos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    delete updateData.id;
    
    const result = await db.executeUpdate('videos', id, updateData);
    
    res.json({
      success: true,
      message: 'Video updated successfully',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    console.error('Update videos error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// -------------------------
// HTML Pages
// -------------------------
app.get('/home', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.get('/productscards', (req, res) => {
  res.sendFile(__dirname + '/productscards.html');
});
app.get('/products', (req, res) => {
  res.sendFile(__dirname + '/products.html');
});
app.get('/appconfigs', (req, res) => {
  res.sendFile(__dirname + '/appconfigs.html');
});
app.get('/sellers', (req, res) => {
  res.sendFile(__dirname + '/sellers.html');
});
app.get('/sellercards', (req, res) => {
  res.sendFile(__dirname + '/sellercards.html');
});
app.get('/productscards', (req, res) => {
  res.sendFile(__dirname + '/productscards.html');
});
app.get('/videos', (req, res) => {
  res.sendFile(__dirname + '/videos.html');
});
app.get('/videoscards', (req, res) => {
  res.sendFile(__dirname + '/videoscards.html');
});
app.get('/users', (req, res) => {
  res.sendFile(__dirname + '/users.html');
});
app.get('/galleries', (req, res) => {
res.sendFile(__dirname + '/galleries.html');
});
app.get('/categories', (req, res) => {
  res.sendFile(__dirname + '/categories.html');
});

app.put('/api/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;
    const updateData = req.body;
    
    const validTables = ['products', 'sellers', 'users', 'videos', 'galleries'];
    if (!validTables.includes(table)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid table name' 
      });
    }
    
    delete updateData.id;
  
    const result = await db.executeUpdate(table, id, updateData);  // Changed    
    res.json({
      success: true,
      message: 'Record updated successfully',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// Get single record endpoint
app.get('/api/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;    
    const validTables = ['products', 'sellers', 'users', 'videos', 'galleries'];
    if (!validTables.includes(table)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid table name' 
      });
    }
  
    const record = await db.getRecordById(table, id);  // Changed
    
    if (!record) {
      return res.status(404).json({
        success: false,
        error: 'Record not found'
      });
    }
    
    res.json({
      success: true,
      data: record
    });
  } catch (error) {
    console.error('Get record error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/debug/products', async (req, res) => {
  try {
    console.log('Debug: Checking products data...');
    
    const testProducts = [];
    if (productsData.length > 0) {
      testProducts = productsData.slice(0, 10).map(p => ({
        id: p.id,
        name: p.name ? p.name.substring(0, 50) : 'No name',
        price: p.price,
        hasImage: !!p.image,
        tagsCount: p.tagsArray ? p.tagsArray.length : 0,
        tagsSample: p.tagsArray ? p.tagsArray.slice(0, 3) : []
      }));
    }
    
    res.json({
      success: true,
      totalProducts: productsData.length,
      sampleProducts: testProducts,
      csvUrl: 'https://raw.githubusercontent.com/Rishi-Singhal-714/chatbot/main/products.csv'
    });
  } catch (error) {
    console.error('Debug error:', error);
    res.status(500).json({ error: error.message });
  }
});
// Add enhanced products endpoint with category and seller names
app.get('/api/productsenhanced', async (req, res) => {
  try {
    const products = await db.getCachedData('products');
    const categories = await db.getCachedData('categories');
    const sellers = await db.getCachedData('sellers');
    
    const categoryMap = {};
    categories.forEach(cat => {
      categoryMap[cat.id] = cat.name;
    });
  
    const sellerMap = {};
    sellers.forEach(seller => {
      sellerMap[seller.user_id] = seller.store_name;
    });
    
    const enhancedProducts = products.map(product => {
      const enhanced = {
        ...product,
        category_name: categoryMap[product.category_id] || '',
        cat1_name: categoryMap[product.cat1] || '',
        seller_name: sellerMap[product.seller_id] || '',
        formatted_price: product.retail_simple_price ? 
          `₹${parseFloat(product.retail_simple_price).toFixed(2)}` : '',
        formatted_special_price: product.retail_simple_special_price ? 
          `₹${parseFloat(product.retail_simple_special_price).toFixed(2)}` : '',
        discount_percent: product.retail_simple_price && product.retail_simple_special_price ?
          Math.round(((product.retail_simple_price - product.retail_simple_special_price) / product.retail_simple_price) * 100) : 0
      };
      
      return enhanced;
    });
    
    res.json({
      success: true,
      data: enhancedProducts,
      categories: categories,
      sellers: sellers,
      count: enhancedProducts.length
    });
  } catch (error) {
    console.error('Error fetching enhanced products:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'Zulu Club Chat Server with Authentication is running', 
    service: 'Zulu Club Chat AI Assistant',
    version: '1.0 - Unlimited Basic Access',
    employee_numbers: EMPLOYEE_NUMBERS,
    endpoints: {
      chat_interface: '/chat',
      create_session: 'POST /chat/create-session',
      send_otp: 'POST /auth/send-otp',
      verify_otp: 'POST /auth/verify-otp',
      check_status: 'POST /auth/check-status',
      logout: 'POST /auth/logout',
      send_message: 'POST /chat/message',
      get_history: 'GET /chat/history/:sessionId'
    },
    stats: {
      product_categories_loaded: galleriesData.length,
      sellers_loaded: sellersData.length,
      active_conversations: Object.keys(conversations).length,
      verified_users: Object.keys(verifiedUsers).length
    },
    access_model: {
      unauthenticated: 'Company & Product intents only (unlimited)',
      authenticated: 'All intents (seller, investors, agent, voice_ai)',
      authentication_required: 'For seller, investors, agent, and voice_ai features'
    },
    timestamp: new Date().toISOString()
  });
});
app.get('/refresh-csv', async (req, res) => {
  try {
    galleriesData = await loadGalleriesData();
    sellersData = await loadSellersData();
    res.json({ 
      status: 'success', 
      message: 'CSV data refreshed successfully', 
      categories_loaded: galleriesData.length, 
      sellers_loaded: sellersData.length 
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});
// AI Endpoints
app.use('/ai-cache', express.static(path.join(__dirname, 'public', 'ai-cache')));

async function cacheImageFor5Min(imageSource, req) {
    let buffer;

    // If it's a data URL (base64)
    if (imageSource.startsWith('data:image')) {
        const base64 = imageSource.split(',')[1];
        buffer = Buffer.from(base64, 'base64');
    }
    // If it's raw base64 without header
    else if (/^[A-Za-z0-9+/=]+$/.test(imageSource.slice(0, 100))) {
        buffer = Buffer.from(imageSource, 'base64');
    }
    // If it's a normal URL
    else {
        const response = await fetch(imageSource);
        buffer = Buffer.from(await response.arrayBuffer());
    }

    const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
    const dir = path.join(__dirname, 'public', 'ai-cache');
    const filepath = path.join(dir, filename);

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, buffer);

    // Auto delete after 5 minutes
    setTimeout(() => {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }, 5 * 60 * 1000);

    return `${req.protocol}://${req.get('host')}/ai-cache/${filename}`;
}
app.post('/api/ai/enhance-image', async (req, res) => {
    try {
        const { imageUrl, productName } = req.body;

        if (!imageUrl) {
            return res.status(400).json({ success: false, error: 'No image URL provided' });
        }

        console.log('🔄 Enhancing image:', imageUrl);

        let base64Image;
        const imgRes = await fetch(imageUrl);
        const buffer = await imgRes.arrayBuffer();
        base64Image = Buffer.from(buffer).toString('base64');

        const prompt = `
Ultra-realistic studio product enhancement.
Product: ${productName || 'Unknown'}
No crop, no reshape, no text, no humans.
Premium lighting, white background.
`;

        try {
            const response = await openai.responses.create({
                model: "gpt-4.1",
                input: [{
                    role: "user",
                    content: [
                        { type: "input_text", text: prompt },
                        { type: "input_image", image_url: `data:image/jpeg;base64,${base64Image}` }
                    ]
                }],
                tools: [{ type: "image_generation", size: "1024x1536", quality: "high" }]
            });

            let enhancedImageUrl = null;
            for (const out of response.output || []) {
                if (out.type === "image_generation_call") enhancedImageUrl = out.result;
                if (out.type === "message") {
                    for (const c of out.content || []) {
                        if (c.type === "image") enhancedImageUrl = c.image_url;
                    }
                }
            }

            if (!enhancedImageUrl) throw new Error("No image returned");

            const cachedUrl = await cacheImageFor5Min(enhancedImageUrl, req);

            return res.json({
                success: true,
                enhancedImageUrl: cachedUrl,
                ttl: 300
            });

        } catch (err) {
            console.error("Primary enhancement failed:", err);

            const dalle = await openai.images.generate({
                model: "dall-e-3",
                prompt: `Studio product photo of ${productName}, white background, premium lighting.`,
                size: "1024x1024",
                quality: "high"
            });

            const cachedUrl = await cacheImageFor5Min(dalle.data[0].url);

            return res.json({
                success: true,
                enhancedImageUrl: cachedUrl,
                fallback: true,
                ttl: 300
            });
        }

    } catch (error) {
        return res.status(500).json({
            success: false,
            enhancedImageUrl: req.body.imageUrl,
            error: error.message
        });
    }
});
app.post('/api/ai/analyze-categories', async (req, res) => {
    try {
        const { productName, currentCategory, currentCat1, imageUrl, description } = req.body;
        
        console.log('🔄 Analyzing categories for:', productName);
        
        const categories = await db.getCachedData('categories');
        
        if (!categories || categories.length === 0) {
            console.warn('No categories found in database');
            db.clearCache('categories');
            const freshCategories = await db.getCachedData('categories');
            if (!freshCategories || freshCategories.length === 0) {
                categories = [
                    { id: 1, name: "Electronics", parent_id: 0 },
                    { id: 2, name: "Clothing", parent_id: 0 },
                    { id: 3, name: "Home & Kitchen", parent_id: 0 },
                    { id: 4, name: "Beauty", parent_id: 0 },
                    { id: 5, name: "Sports", parent_id: 0 },
                    { id: 6, name: "Books", parent_id: 0 },
                    { id: 7, name: "Toys", parent_id: 0 }
                ];
            } else {
                categories = freshCategories;
            }
        }
        
        const mainCategories = categories.filter(cat => cat.parent_id === 0 || cat.parent_id === null);
        const allCategories = categories.map(cat => ({
            id: cat.id,
            name: cat.name,
            parent_id: cat.parent_id,
            parentName: cat.parent_id ? categories.find(p => p.id === cat.parent_id)?.name || 'Unknown' : null
        }));
        
        const categoryOptions = allCategories.map(cat => {
            if (cat.parent_id) {
                return `${cat.id}: ${cat.name} (Sub-category of ${cat.parentName})`;
            }
            return `${cat.id}: ${cat.name} (Main Category)`;
        }).join('\n');
        
        const prompt = `
        Analyze this product and suggest the best category and sub-category (cat1) from the available options.
        
        PRODUCT DETAILS:
        - Name: ${productName}
        - Current Category: ${currentCategory || 'Not set'}
        - Current Cat1: ${currentCat1 || 'Not set'}
        - Description: ${description || 'No description'}
        
        AVAILABLE CATEGORIES:
        ${categoryOptions}
        
        INSTRUCTIONS:
        1. Look at the product name and description to understand what it is
        2. If current category seems correct, suggest keeping it
        3. If current category seems wrong, suggest the most appropriate category
        4. For cat1 (sub-category), suggest the most specific relevant category
        5. Only suggest categories that exist in the available list
        6. If suggesting a change, explain why
        7. Return in valid JSON format only
        
        IMPORTANT:
        - cat1 MUST be a sub-category of the main category (check parent_id)
        - If no perfect match exists, choose the closest general category
        - Do NOT invent new category names
        
        RETURN JSON FORMAT:
        {
            "suggestedCategory": {"id": 123, "name": "Category Name"},
            "suggestedCat1": {"id": 456, "name": "Cat1 Name"},
            "analysis": "Brief explanation of why these categories were chosen"
        }
        `;
        
        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ],
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 500
        });
        
        let result;
        try {
            result = JSON.parse(response.choices[0].message.content);
            
            const suggestedCat = allCategories.find(cat => cat.id == result.suggestedCategory?.id);
            const suggestedCat1 = allCategories.find(cat => cat.id == result.suggestedCat1?.id);
            
            if (!suggestedCat) {
                console.warn('Suggested category not found:', result.suggestedCategory);
                const similarCat = allCategories.find(cat => 
                    cat.name.toLowerCase().includes(productName.toLowerCase().split(' ')[0]) ||
                    productName.toLowerCase().includes(cat.name.toLowerCase())
                );
                
                if (similarCat) {
                    result.suggestedCategory = { id: similarCat.id, name: similarCat.name };
                    result.analysis += ` (Category adjusted to "${similarCat.name}" based on similarity)`;
                } else {
                    result.suggestedCategory = { id: mainCategories[0]?.id || 1, name: mainCategories[0]?.name || "General" };
                    result.analysis += " (Using default category)";
                }
            }
            
            if (!suggestedCat1 && result.suggestedCat1) {
                console.warn('Suggested cat1 not found:', result.suggestedCat1);
                result.suggestedCat1 = null;
                result.analysis += " (Cat1 suggestion removed as it was invalid)";
            }
            
            if (result.suggestedCat1 && result.suggestedCategory) {
                const cat1Item = allCategories.find(cat => cat.id == result.suggestedCat1.id);
                if (cat1Item && cat1Item.parent_id !== result.suggestedCategory.id) {
                    console.warn('Cat1 is not a sub-category of main category');
                    const validSubCat = allCategories.find(cat => 
                        cat.parent_id === result.suggestedCategory.id
                    );
                    if (validSubCat) {
                        result.suggestedCat1 = { id: validSubCat.id, name: validSubCat.name };
                        result.analysis += ` (Adjusted cat1 to valid sub-category "${validSubCat.name}")`;
                    } else {
                        result.suggestedCat1 = null;
                        result.analysis += " (Removed cat1 as no valid sub-category found)";
                    }
                }
            }
            
        } catch (parseError) {
            console.error("Failed to parse AI response:", parseError);
            const defaultCat = mainCategories[0] || { id: 1, name: "General" };
            result = {
                suggestedCategory: { id: defaultCat.id, name: defaultCat.name },
                suggestedCat1: null,
                analysis: "Default category assigned due to parsing error. Based on product name analysis, this seems appropriate."
            };
        }
        
        console.log('Category analysis completed');
        
        res.json({
            success: true,
            ...result
        });
        
    } catch (error) {
        console.error('Category analysis error:', error);
        
        let categories = [];
        try {
            categories = await db.getCachedData('categories');
        } catch (dbError) {
            console.error('Failed to fetch categories for fallback:', dbError);
        }
        
        const mainCategories = categories.filter(cat => cat.parent_id === 0 || cat.parent_id === null);
        const defaultCat = mainCategories[0] || { id: 1, name: "General" };
        
        res.json({ 
            success: true, 
            suggestedCategory: { id: defaultCat.id, name: defaultCat.name },
            suggestedCat1: null,
            analysis: "Error occurred during analysis. Using default category.",
            warning: error.message
        });
    }
});
app.post('/api/ai/generate-tags', async (req, res) => {
    try {
        const { productName, category, cat1, description, price } = req.body;
        
        console.log('🔄 Generating tags for:', productName);
        
        const prompt = `
        Generate exactly 10 relevant tags for this product. Follow these rules:
        
        PRODUCT: ${productName}
        CATEGORY: ${category || 'Not specified'}
        SUB-CATEGORY: ${cat1 || 'Not specified'}
        DESCRIPTION: ${description || 'No description'}
        PRICE RANGE: ${price ? (price < 100 ? 'Budget' : price < 500 ? 'Mid-range' : 'Premium') : 'Not specified'}
        
        TAG REQUIREMENTS:
        1. SEO-friendly keywords
        2. Relevant to product, category, and sub-category
        3. Include use-case keywords (how it's used)
        4. Include feature keywords (what it does/has)
        5. Include style/type keywords
        6. All lowercase
        7. No special characters or symbols
        8. Max 2 words per tag
        9. No duplicates
        10. Include both singular and plural forms where relevant
        
        FORMAT:
        Return as a JSON array of exactly 10 strings.
        
        EXAMPLE OUTPUT:
        {
            "tags": ["smartphone", "android phone", "mobile device", "touchscreen", "64mp camera", "5g enabled", "long battery", "premium design", "gaming phone", "fast charging"]
        }
        `;
        
        const response = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ],
            response_format: { type: "json_object" },
            temperature: 0.5,
            max_tokens: 300
        });
        
        let result;
        try {
            result = JSON.parse(response.choices[0].message.content);
            
            if (!result.tags || !Array.isArray(result.tags)) {
                result.tags = [];
            }
            
            result.tags = result.tags
                .filter(tag => typeof tag === 'string')
                .map(tag => tag.toLowerCase().trim())
                .filter(tag => tag.length > 0 && tag.length <= 30)
                .filter((tag, index, self) => self.indexOf(tag) === index) // Remove duplicates
                .slice(0, 10); 
            
            if (result.tags.length < 10) {
                const basicTags = productName.toLowerCase().split(' ')
                    .filter(word => word.length > 2)
                    .slice(0, 5);
                
                result.tags = [...new Set([...result.tags, ...basicTags])].slice(0, 10);
            }
            
        } catch (parseError) {
            console.error("Failed to parse tags response:", parseError);
            const basicTags = productName.toLowerCase().split(' ')
                .filter(word => word.length > 2)
                .slice(0, 10);
            result = { tags: basicTags };
        }
        
        console.log(`Generated ${result.tags.length} tags`);
        
        res.json({
            success: true,
            tags: result.tags
        });
        
    } catch (error) {
        console.error('Tag generation error:', error);
        const fallbackTags = req.body.productName 
            ? req.body.productName.toLowerCase().split(' ')
                .filter(word => word.length > 2)
                .slice(0, 5)
            : [];
        
        res.json({ 
            success: true,
            tags: fallbackTags,
            warning: error.message
        });
    }
});
app.post('/api/ai/generate-descriptions', async (req, res) => {
    try {
        const { productName, category, cat1, tags, price, currentDescription } = req.body;
        
        console.log('🔄 Generating descriptions for:', productName);
        
        // Format price for description
        const priceText = price ? `₹${parseFloat(price).toFixed(2)}` : 'affordable price';
        
        // Main description prompt
        const mainPrompt = `
        Write a compelling, SEO-optimized product description.
        
        PRODUCT: ${productName}
        CATEGORY: ${category || 'General'}
        SUB-CATEGORY: ${cat1 || 'Not specified'}
        KEY TAGS: ${tags ? tags.slice(0, 5).join(', ') : 'Not specified'}
        
        EXISTING DESCRIPTION (for reference only):
        ${currentDescription || 'No existing description'}
        
        REQUIREMENTS:
        - Length: 80-120 words
        - Include: Product benefits, key features, use cases
        - Tone: Professional yet engaging
        - SEO: Include main keywords naturally
        - Structure: Introduction → Features → Benefits → Call to Action
        - No markdown formatting
        - End with a compelling call-to-action
        
        Focus on why this product is valuable and how it solves problems.
        `;
        
        // Extra description prompt (Indian millennial style)
        const extraPrompt = `
        Write an EXTRA quirky Indian millennial-style product description with only 3-4 short reasons.
        
        Strict Rules:
        - Do NOT mention the product name
        - Do NOT start with any title or heading
        - Output only 3-4 punchy one-liners
        - Tone: modern Indian, fun, confident, slightly playful
        - Inspired by art, colours, and aesthetics
        - Suitable for men, women, and kids
        - Mention affordability but NEVER exact numbers
        - Use comparisons like coffee, movie ticket, dinner, under 1k
        - Do NOT use: '  "  **  or any special symbols
        - Keep language simple, clean and commercial
        
        Context (for inspiration only):
        Product Type: ${category || 'General'}
        Style: ${cat1 || 'Contemporary'}
        Key Features: ${tags ? tags.slice(0, 3).join(', ') : 'Quality'}
        
        Return ONLY the 3-4 one-liners, nothing else.
        `;
        
        // Generate main description
        const mainResponse = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "user",
                    content: mainPrompt
                }
            ],
            temperature: 0.7,
            max_tokens: 300
        });
        
        const mainDescription = mainResponse.choices[0].message.content.trim();
        
        // Generate extra description
        const extraResponse = await openai.chat.completions.create({
            model: "gpt-4.1",
            messages: [
                {
                    role: "user",
                    content: extraPrompt
                }
            ],
            temperature: 0.8,
            max_tokens: 150
        });
        
        let extraDescription = extraResponse.choices[0].message.content.trim();
        
        // Clean up extra description
        extraDescription = extraDescription
            .replace(/^["']|["']$/g, '') // Remove quotes
            .replace(/\*\*/g, '') // Remove bold markers
            .split('\n')
            .filter(line => line.trim())
            .slice(0, 4)
            .join('\n');
        
        console.log('Descriptions generated successfully');
        
        res.json({
            success: true,
            description: mainDescription,
            extraDescription: extraDescription
        });
        
    } catch (error) {
        console.error('Description generation error:', error);
        
        // Create fallback descriptions
        const fallbackMain = `Introducing ${req.body.productName || 'this product'}, a premium quality item that combines style and functionality. Perfect for everyday use, it offers great value and reliable performance. ${req.body.category ? `Ideal for ${req.body.category} enthusiasts.` : ''} Get yours today and experience the difference!`;
        
        const fallbackExtra = `Looks amazing in any setup\nGreat value for the price\nPerfect for gifting\nTrusted quality`;
        
        res.json({ 
            success: true,
            description: fallbackMain,
            extraDescription: fallbackExtra,
            warning: error.message
        });
    }
});
// app.post('/chat/history-sheets') - Pagination logic को बदलें
app.post('/chat/history-sheets', async (req, res) => {
    try {
        const { phoneNumber, page = 0, pageSize = 10 } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: 'Phone number is required'
            });
        }
        
        // Check if user is authenticated
        const user = verifiedUsers[phoneNumber];
        if (!user || !user.verified) {
            return res.status(401).json({
                success: false,
                error: 'User not authenticated'
            });
        }
        
        console.log(`Fetching sheets history for ${phoneNumber}, page ${page}, pageSize ${pageSize}`);
        
        // Get the Google Sheets client
        const sheets = await getSheets();
        if (!sheets) {
            console.log('Google Sheets not configured, returning empty history');
            return res.json({
                success: true,
                history: '',
                messages: [],
                hasMore: false,
                totalMessages: 0,
                currentPage: page,
                pageSize: pageSize
            });
        }
        
        try {
            const headersResp = await sheets.spreadsheets.values.get({ 
                spreadsheetId: GOOGLE_SHEET_ID, 
                range: 'History!1:1' 
            });
            
            const headers = (headersResp.data.values && headersResp.data.values[0]) || [];
            
            let colIndex = -1;
            for (let i = 0; i < headers.length; i++) {
                const header = String(headers[i]).trim();
                if (header === phoneNumber) {
                    colIndex = i;
                    break;
                }
            }
            
            if (colIndex === -1) {
                console.log(`📜 No history found for ${phoneNumber} in sheets`);
                return res.json({
                    success: true,
                    history: '',
                    messages: [],
                    hasMore: false,
                    totalMessages: 0,
                    currentPage: page,
                    pageSize: pageSize
                });
            }
            
            const colLetter = String.fromCharCode(65 + colIndex);
            const range = `History!${colLetter}2:${colLetter}`;
            
            const colResp = await sheets.spreadsheets.values.get({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: range,
                majorDimension: 'COLUMNS'
            });
            
            const columnValues = (colResp.data.values && colResp.data.values[0]) || [];
            
            console.log(`Found ${columnValues.length} messages in column`);
            
            const allMessages = [];
            
            columnValues.forEach((cellValue, index) => {
                if (cellValue && typeof cellValue === 'string' && cellValue.trim()) {
                    const parts = cellValue.split(' | ');
                    if (parts.length >= 2) {
                        const timestamp = parts[0];
                        const content = parts.slice(1).join(' | ').trim();
                        
                        if (content) {
                            let sender = 'bot';
                            let messageText = content;
                            
                            if (content.startsWith('USER:')) {
                                sender = 'user';
                                messageText = content.substring(5).trim();
                            } else if (content.startsWith('ASSISTANT:')) {
                                sender = 'bot';
                                messageText = content.substring(10).trim();
                            }
                            
                            const displayTime = parseIndiaTimeForDisplay(timestamp);
                            
                            allMessages.push({
                                text: messageText,
                                sender: sender,
                                timestamp: timestamp,
                                displayTime: displayTime,
                                sheetIndex: index 
                            });
                        }
                    }
                }
            });
            
            const totalMessages = allMessages.length;
            
            const limit = (page + 1) * pageSize;
            const maxMessages = Math.min(limit, totalMessages);
            
            console.log(`Cumulative pagination: total=${totalMessages}, page=${page}, limit=${limit}, maxMessages=${maxMessages}`);
            
            let pageMessages = [];
            if (maxMessages > 0) {
                pageMessages = allMessages.slice(0, maxMessages);
            }
            
            const hasMore = maxMessages < totalMessages;
            
            console.log(`Returning ${pageMessages.length} messages (0 to ${maxMessages-1}), hasMore=${hasMore}`);
            
            return res.json({
                success: true,
                history: '',
                messages: pageMessages,
                hasMore: hasMore,
                totalMessages: totalMessages,
                currentPage: page,
                pageSize: pageSize
            });
        } catch (error) {
            console.error('Error reading from Google Sheets:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to read history from Google Sheets',
                details: error.message
            });
        }
    } catch (error) {
        console.error('Chat history endpoint error:', error.message);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
// Helper function to format timestamp for display
function parseIndiaTimeForDisplay(timestampStr) {
    try {
        const parts = timestampStr.split(' ');
        if (parts.length < 2) return timestampStr;
        
        const timePart = parts[1];
        const [hours, minutes, seconds] = timePart.split(':').map(Number);
        
        let displayHours = hours % 12 || 12;
        const ampm = hours >= 12 ? 'PM' : 'AM';
        
        return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
    } catch (error) {
        console.error('Error formatting timestamp:', timestampStr, error);
        return timestampStr;
    }
}

setInterval(() => {
  const now = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;
  let cleanedCount = 0;
  
  for (const phoneNumber in verifiedUsers) {
    if (now - verifiedUsers[phoneNumber].verifiedAt > twentyFourHours) {
      delete verifiedUsers[phoneNumber];
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`🧹 Cleaned up ${cleanedCount} expired verifications`);
  }
}, 60 * 60 * 1000);

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Zulu Chat Server running at http://localhost:${PORT}`);
  });
}
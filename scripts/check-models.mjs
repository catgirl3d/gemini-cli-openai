import fs from 'node:fs';
import path from 'node:path';

const DEV_VARS_PATH = '.dev.vars';

// These are the official OAuth2 credentials for the "Google Gemini CLI" application.
// They are used to identify the application when refreshing the access_token.
// These values are public and same for all users of the Gemini CLI tool.
// we need them here to allow the script to automatically refresh session
// using the refresh_token from .dev.vars without requiring manual re-authentication.
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";

const MODELS_TO_CHECK = [
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
];

async function run() {
    console.log(`--- Gemini Model Availability Checker ---\n`);

    if (!fs.existsSync(DEV_VARS_PATH)) {
        console.error(`❌ Error: ${DEV_VARS_PATH} file not found in the current directory.`);
        console.log(`Please create it based on .dev.vars.example`);
        process.exit(1);
    }

    const content = fs.readFileSync(DEV_VARS_PATH, 'utf8');
    const env = {};
    content.split('\n').forEach(line => {
        const match = line.match(/^\s*(\w+)\s*=\s*(.*)\s*$/);
        if (match) {
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            env[match[1]] = value;
        }
    });

    if (!env.GCP_SERVICE_ACCOUNT) {
        console.error('❌ Error: GCP_SERVICE_ACCOUNT not found in .dev.vars');
        process.exit(1);
    }

    let creds;
    try {
        creds = JSON.parse(env.GCP_SERVICE_ACCOUNT);
    } catch (e) {
        console.error('❌ Error: Failed to parse GCP_SERVICE_ACCOUNT as JSON');
        process.exit(1);
    }

    let projectId = env.GEMINI_PROJECT_ID;
    if (!projectId) {
        console.log('⚠️  GEMINI_PROJECT_ID not found in .dev.vars. Will attempt auto-discovery via loadCodeAssist.');
    } else {
        console.log(`✅ Using Project ID from .dev.vars: ${projectId}`);
    }
    
    let accessToken = creds.access_token;

    if (creds.expiry_date && Date.now() > creds.expiry_date - 60000) {
        console.log('🔄 Token expired or expiring soon, refreshing...');
        if (!creds.refresh_token) {
            console.error('❌ Error: refresh_token missing in GCP_SERVICE_ACCOUNT. Cannot refresh.');
            process.exit(1);
        }

        try {
            const refreshResponse = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: OAUTH_CLIENT_ID,
                    client_secret: OAUTH_CLIENT_SECRET,
                    refresh_token: creds.refresh_token,
                    grant_type: 'refresh_token'
                })
            });

            if (refreshResponse.ok) {
                const data = await refreshResponse.json();
                accessToken = data.access_token;
                console.log('✅ Token refreshed successfully.');
            } else {
                console.error('❌ Failed to refresh token:', await refreshResponse.text());
                process.exit(1);
            }
        } catch (e) {
            console.error('❌ Error during token refresh:', e.message);
            process.exit(1);
        }
    }

    console.log('\n--- Checking loadCodeAssist ---');
    try {
        const response = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                cloudaicompanionProject: projectId || 'default-project',
                metadata: { duetProject: projectId || 'default-project' }
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log('✅ loadCodeAssist call successful.');
            if (data.cloudaicompanionProject) {
                if (!projectId) {
                    console.log(`✨ Discovered Project ID: ${data.cloudaicompanionProject}`);
                    projectId = data.cloudaicompanionProject;
                } else if (projectId !== data.cloudaicompanionProject) {
                    console.log(`ℹ️  Note: API returned a different project ID (${data.cloudaicompanionProject}) than configured (${projectId}).`);
                }
            }
            if (data.currentTier) {
                console.log(`📊 Current Tier: ${data.currentTier.id} (${data.currentTier.name})`);
            }
        } else {
            console.log(`❌ loadCodeAssist failed: ${response.status}`);
            if (!projectId) {
                console.error('❌ Error: Could not discover Project ID and none was provided.');
                process.exit(1);
            }
        }
    } catch (e) {
        console.log(`❌ loadCodeAssist error: ${e.message}`);
        if (!projectId) process.exit(1);
    }
    console.log('');

    console.log(`🚀 Checking models for project: ${projectId} (API: v1internal)\n`);

    for (const modelId of MODELS_TO_CHECK) {
        const url = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`;
        const body = {
            model: modelId,
            project: projectId,
            request: {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 1 }
            }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                },
                body: JSON.stringify(body)
            });

            if (response.ok) {
                console.log(`✅ ${modelId.padEnd(25)}: 200 OK`);
            } else if (response.status === 429) {
                console.log(`⚠️  ${modelId.padEnd(25)}: 429 (Capacity Exhausted/Rate Limit)`);
            } else {
                console.log(`❌ ${modelId.padEnd(25)}: ${response.status}`);
            }
        } catch (e) {
            console.log(`❌ ${modelId.padEnd(25)}: Error ${e.message}`);
        }
    }
    console.log('');
}

run();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const port = 8800;

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const consumerKey = 'Acjo0P9UnsKVg66bQ3ahGYRkLcEg3ve2kksTPeSNkM2sR4MH';
const consumerSecret = '2L768uGriTiMd8GaUXkaAMeUrF157tJAYdXX0K0MxHGiv1bzUZCPNVix0kDNQtr6';
const shortCode = '174379';
const passkey = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

console.log(shortCode, "passkey", passkey);
let transactions = [];
console.log(transactions);

async function getAccessToken() {
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        headers: {
            Authorization: `Basic ${auth}`,
        },
    });
    console.log("Access token generated:", response.data.access_token);
    return response.data.access_token;
}

app.post('/initiate-stk-push', async (req, res) => {
    const { phone, amount } = req.body;
    try {
        const accessToken = await getAccessToken();
        const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
      
        const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
        
        // Determine the callback URL - use the public tunnel URL if available
        const callbackUrl = publicUrl 
            ? `${publicUrl}/callback` 
            : 'https://ericken-dev.github.io/olidin-landing-page-2024/callback';
        
        console.log(`Using callback URL: ${callbackUrl}`);
        
        const response = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: shortCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: amount,
                PartyA: phone,
                PartyB: shortCode,
                PhoneNumber: phone,
                CallBackURL: callbackUrl,
                AccountReference: 'Test',
                TransactionDesc: 'Test STK Push',
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );
        
        // Store the initiated transaction
        const transaction = {
            id: transactions.length + 1,
            checkoutRequestID: response.data.CheckoutRequestID,
            merchantRequestID: response.data.MerchantRequestID,
            amount,
            phoneNumber: phone,
            status: 'pending',
            date: new Date().toISOString(),
        };
        transactions.push(transaction);
       
        console.log('New transaction created:');
        console.log(JSON.stringify(transaction, null, 2));
        console.log('Current transactions count:', transactions.length);
        console.log('STK push initiated with checkout request ID:', response.data.CheckoutRequestID);
       
        res.json({ message: 'STK push initiated successfully', data: response.data, transactionId: transaction.id });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'An error occurred', error: error.message });
    }
});

app.post('/callback', (req, res) => {
    console.log('Received M-Pesa callback:', JSON.stringify(req.body, null, 2));
    
    const { Body } = req.body;
    
    // Check if Body and stkCallback exist
    if (!Body || !Body.stkCallback) {
        console.log('Invalid callback data: Missing Body or stkCallback');
        return res.status(400).json({ 
            ResultCode: 1, 
            ResultDesc: 'Invalid callback data' 
        });
    }
    
    const transaction = transactions.find(t => 
        t.checkoutRequestID === Body.stkCallback.CheckoutRequestID
    );
    
    if (transaction) {
        if (Body.stkCallback.ResultCode === 0) {
            // Payment successful
            console.log('Payment successful for transaction:', transaction.checkoutRequestID);
            
            // Find the receipt number from callback metadata
            let mpesaReceiptNumber = '';
            if (Body.stkCallback.CallbackMetadata && 
                Body.stkCallback.CallbackMetadata.Item) {
                
                const receiptItem = Body.stkCallback.CallbackMetadata.Item.find(
                    item => item.Name === 'MpesaReceiptNumber'
                );
                
                if (receiptItem && receiptItem.Value) {
                    mpesaReceiptNumber = receiptItem.Value;
                }
            }
            
            // Update transaction
            transaction.status = 'paid';
            transaction.mpesaReceiptNumber = mpesaReceiptNumber;
            
            console.log('Updated transaction with receipt:', mpesaReceiptNumber);
        } else {
            // Payment cancelled or failed
            console.log('Payment failed with code:', Body.stkCallback.ResultCode);
            transaction.status = 'failed';
            transaction.resultDesc = Body.stkCallback.ResultDesc;
            
            console.log('Failed transaction details:', {
                id: transaction.checkoutRequestID,
                reason: Body.stkCallback.ResultDesc
            });
        }
    } else {
        console.log('Transaction not found for CheckoutRequestID:', 
            Body.stkCallback.CheckoutRequestID);
    }
    
    // Always respond with success to acknowledge receipt
    console.log('Sending callback response');
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/transactions', (req, res) => {
    res.json(transactions);
});

app.get('/transaction/:id', (req, res) => {
    const transaction = transactions.find(t => t.id === parseInt(req.params.id));
    if (transaction) {
        res.json(transaction);
    } else {
        res.status(404).json({ message: 'Transaction not found' });
    }
});

// Set up the main server with SSH tunnel for public access
let publicUrl = null;

const server = app.listen(port, () => {
    console.log(`M-Pesa server running at http://localhost:${port}`);
    
    // Create SSH tunnel for public access via serveo.net
    const { spawn } = require('child_process');
    const ssh = spawn('ssh', ['-R', '80:localhost:8800', 'serveo.net']);
    
    ssh.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`SSH tunnel output: ${output}`);
        
        // Extract the public URL from serveo.net output
        // The format is usually "Forwarding HTTP traffic from https://[subdomain].serveo.net"
        const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.serveo\.net/);
        if (match && !publicUrl) {
            publicUrl = match[0];
            console.log(`Public URL detected: ${publicUrl}`);
            console.log(`Callback URL will be: ${publicUrl}/callback`);
        }
    });
    
    ssh.stderr.on('data', (data) => {
        console.error(`SSH tunnel error: ${data}`);
    });
    
    process.on('SIGINT', () => {
        console.log('Shutting down server and SSH tunnel...');
        ssh.kill();
        server.close();
        process.exit();
    });
});

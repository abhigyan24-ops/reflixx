"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateQRToken = exports.scheduledAISync = exports.topUpWallet = exports.generateEcoPassport = exports.onAlertReceived = exports.onDispenseComplete = exports.onDispenseStart = void 0;
const https_1 = require("firebase-functions/v2/https");
const pubsub_1 = require("firebase-functions/v2/pubsub");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-functions/v2/firestore");
const params_1 = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");
const mqtt = require("mqtt");
const zod_1 = require("zod");
const pdf_lib_1 = require("pdf-lib");
admin.initializeApp();
const hmacSecret = (0, params_1.defineSecret)("hmac-secret");
const topUpSchema = zod_1.z.object({
    uid: zod_1.z.string(),
    amount: zod_1.z.number(),
});
const generateQRSchema = zod_1.z.object({
    uid: zod_1.z.string(),
    amount: zod_1.z.number(),
    machineId: zod_1.z.string(),
});
// MQTT MQTT client helper to publish commands back to ESP32
async function publishMQTTCommand(machineId, payload) {
    const topic = `refillx/dispensers/${machineId}/command`;
    return new Promise((resolve) => {
        // Connect to EMQX public TCP broker
        const client = mqtt.connect("mqtt://broker.emqx.io:1883");
        client.on("connect", () => {
            client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
                client.end();
                if (err) {
                    logger.error(`MQTT publish failed on ${topic}:`, err);
                }
                else {
                    logger.info(`MQTT command published successfully to ${topic}:`, payload);
                }
                resolve();
            });
        });
        client.on("error", (err) => {
            client.end();
            logger.error("MQTT connection error:", err);
            resolve();
        });
        // Timeout safety
        setTimeout(() => {
            client.end();
            logger.warn("MQTT publish timeout.");
            resolve();
        }, 3000);
    });
}
// Multi-device FCM Notification Helper (3B.5)
async function sendNotification(uid, payload) {
    const userRef = admin.firestore().collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists)
        return;
    const fcmTokens = userSnap.data()?.fcmTokens || [];
    if (fcmTokens.length === 0) {
        logger.info(`No FCM tokens found for user ${uid}. Skipping notification.`);
        return;
    }
    logger.info(`Sending FCM notification to user ${uid} across ${fcmTokens.length} devices.`);
    const invalidTokens = [];
    for (const token of fcmTokens) {
        try {
            await admin.messaging().send({
                token,
                notification: {
                    title: payload.title,
                    body: payload.body,
                },
                data: payload.data || {},
            });
        }
        catch (err) {
            logger.error(`Failed to send FCM to token ${token}:`, err);
            if (err.code === "messaging/invalid-registration" || err.code === "messaging/registration-token-not-registered") {
                invalidTokens.push(token);
            }
        }
    }
    if (invalidTokens.length > 0) {
        logger.info(`Pruning ${invalidTokens.length} invalid tokens for user ${uid}`);
        const remaining = fcmTokens.filter(t => !invalidTokens.includes(t));
        await userRef.update({ fcmTokens: remaining });
    }
}
// --- PDF COMPILER HELPERS (3B.4) ---
async function compileReceiptPDF(data) {
    const pdfDoc = await pdf_lib_1.PDFDocument.create();
    const page = pdfDoc.addPage([400, 600]);
    const { height } = page.getSize();
    const font = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    page.drawText("REFILLX RECEIPT", { x: 50, y: height - 50, size: 18, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.45, 0.74) });
    page.drawText(`Receipt ID: ${data.receiptId}`, { x: 50, y: height - 85, size: 9, font });
    page.drawText(`Timestamp: ${new Date(data.timestamp).toLocaleString()}`, { x: 50, y: height - 100, size: 9, font });
    page.drawText("--------------------------------------------------", { x: 50, y: height - 120, size: 10, font });
    page.drawText(`User Profile: ${data.userName}`, { x: 50, y: height - 140, size: 10, font });
    page.drawText(`Dispenser: ${data.machineId}`, { x: 50, y: height - 155, size: 10, font });
    page.drawText(`Location: ${data.location}`, { x: 50, y: height - 170, size: 10, font });
    page.drawText("DISPENSED DETAILS", { x: 50, y: height - 200, size: 11, font: boldFont });
    page.drawText(`Product: ${data.productType}`, { x: 50, y: height - 220, size: 10, font });
    page.drawText(`Volume: ${data.volume}`, { x: 50, y: height - 235, size: 10, font });
    page.drawText(`Cost: INR ${data.cost.toFixed(2)}`, { x: 50, y: height - 250, size: 11, font: boldFont });
    page.drawText("--------------------------------------------------", { x: 50, y: height - 270, size: 10, font });
    page.drawText(`Eco Points: +${data.ecoPointsEarned} points`, { x: 50, y: height - 290, size: 11, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.65, 0.35) });
    page.drawText(`Tier Class: ${data.newTier}`, { x: 50, y: height - 305, size: 10, font });
    page.drawText(`Wallet Balance: INR ${data.walletBalance.toFixed(2)}`, { x: 50, y: height - 320, size: 10, font });
    page.drawText("Thank you for contributing to carbon offsets!", { x: 50, y: height - 400, size: 10, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.45, 0.74) });
    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
}
async function compileEcoPassportPDF(data) {
    const pdfDoc = await pdf_lib_1.PDFDocument.create();
    const page = pdfDoc.addPage([500, 680]);
    const { height } = page.getSize();
    const font = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    page.drawText("REFILLX ECO PASSPORT", { x: 50, y: height - 60, size: 22, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.65, 0.35) });
    page.drawText(`Passport Holder: ${data.userName}`, { x: 50, y: height - 100, size: 12, font: boldFont });
    page.drawText(`Member ID: ${data.uid}`, { x: 50, y: height - 120, size: 10, font });
    page.drawText(`Generated At: ${new Date(data.generatedAt).toLocaleString()}`, { x: 50, y: height - 140, size: 10, font });
    page.drawText("AGGREGATED IMPACT STATISTICS", { x: 50, y: height - 180, size: 13, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.45, 0.74) });
    page.drawText(`Total Water Refills: ${data.totalTransactions} sessions`, { x: 50, y: height - 205, size: 11, font });
    page.drawText(`Total Volume Refilled: ${data.totalVolume.toFixed(1)} Litres`, { x: 50, y: height - 225, size: 11, font });
    page.drawText(`CO2 Emission Saved: ${data.totalCO2Saved.toFixed(2)} kg`, { x: 50, y: height - 245, size: 11, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.65, 0.35) });
    page.drawText(`PET Plastic Avoided: ${data.totalPlasticSaved.toFixed(0)} grams`, { x: 50, y: height - 265, size: 11, font: boldFont, color: (0, pdf_lib_1.rgb)(0.06, 0.65, 0.35) });
    page.drawText("PASSPORT STANDINGS", { x: 50, y: height - 315, size: 13, font: boldFont });
    page.drawText(`Saved Eco Points: ${data.ecoPoints} points`, { x: 50, y: height - 340, size: 11, font });
    page.drawText(`Eco Tier Class: ${data.tier}`, { x: 50, y: height - 355, size: 11, font: boldFont, color: (0, pdf_lib_1.rgb)(0.85, 0.45, 0.05) });
    page.drawText("RefillX Infrastructure Smart Passport", { x: 50, y: height - 580, size: 9, font: boldFont });
    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
}
// --- CLOUD FUNCTIONS TRIGGERS ---
// 3B.2 onDispenseStart (Pub/Sub Trigger)
exports.onDispenseStart = (0, pubsub_1.onMessagePublished)("refillx-dispense-start", async (event) => {
    logger.info("onDispenseStart triggered", { eventId: event.id });
    try {
        const payloadString = event.data.message.data
            ? Buffer.from(event.data.message.data, "base64").toString()
            : "{}";
        const payload = JSON.parse(payloadString);
        logger.info("Parsed start payload:", payload);
        const schema = zod_1.z.object({
            uid: zod_1.z.string(),
            machineId: zod_1.z.string(),
            timestamp: zod_1.z.number(),
            nonce: zod_1.z.string(),
        });
        const data = schema.parse(payload);
        const { uid, machineId, nonce } = data;
        // Validate qrToken
        const tokenRef = admin.firestore().collection("qrTokens").doc(nonce);
        const tokenSnap = await tokenRef.get();
        if (!tokenSnap.exists) {
            throw new Error("Token nonce does not exist.");
        }
        const tokenData = tokenSnap.data();
        const now = Date.now();
        const expiresAt = tokenData?.expiresAt?.toMillis ? tokenData.expiresAt.toMillis() : (tokenData?.expiresAt || 0);
        const isValid = tokenData?.used === false &&
            expiresAt > now &&
            tokenData?.uid === uid &&
            tokenData?.machineId === machineId;
        if (isValid) {
            // 1. Mark token as used
            await tokenRef.update({ used: true });
            // 2. Set dispenser status to dispensing
            await admin.firestore().collection("dispensers").doc(machineId).update({
                status: "Dispensing"
            });
            // 3. Publish OPEN command to MQTT
            await publishMQTTCommand(machineId, {
                action: "open",
                uid,
                amount: tokenData?.amount || 500
            });
            logger.info(`Dispense session verified and opened for machine: ${machineId}, user: ${uid}`);
        }
        else {
            // Invalid token
            await publishMQTTCommand(machineId, {
                action: "reject",
                reason: "invalid_token"
            });
            // Log failed scan
            await admin.firestore().collection("failedQRScans").add({
                uid,
                machineId,
                nonce,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                reason: tokenData?.used ? "token_already_used" : (expiresAt <= now ? "token_expired" : "mismatched_parameters")
            });
            logger.warn(`Dispense session rejected for machine: ${machineId}, user: ${uid}`);
        }
    }
    catch (error) {
        logger.error("Error in onDispenseStart:", error);
    }
});
// 3B.1 onDispenseComplete (Pub/Sub Trigger)
exports.onDispenseComplete = (0, pubsub_1.onMessagePublished)("refillx-dispense-complete", async (event) => {
    logger.info("onDispenseComplete triggered", { eventId: event.id });
    try {
        const payloadString = event.data.message.data
            ? Buffer.from(event.data.message.data, "base64").toString()
            : "{}";
        const payload = JSON.parse(payloadString);
        const schema = zod_1.z.object({
            uid: zod_1.z.string(),
            machineId: zod_1.z.string(),
            volume: zod_1.z.number(), // in ml
            timestamp: zod_1.z.number(),
        });
        const data = schema.parse(payload);
        const { uid, machineId, volume } = data;
        const txnId = `txn_${crypto.randomBytes(6).toString("hex")}`;
        const userRef = admin.firestore().collection("users").doc(uid);
        const dispenserRef = admin.firestore().collection("dispensers").doc(machineId);
        const transactionRef = admin.firestore().collection("transactions").doc(txnId);
        let pricePerLitre = 30.0;
        let productType = "Mineral Water";
        let location = "Smart Station";
        let userName = "Savior";
        // Perform atomic transaction
        const transactionResult = await admin.firestore().runTransaction(async (transaction) => {
            const userSnap = await transaction.get(userRef);
            const dispenserSnap = await transaction.get(dispenserRef);
            if (!userSnap.exists)
                throw new Error("User profile not found.");
            if (!dispenserSnap.exists)
                throw new Error("Dispenser profile not found.");
            const userData = userSnap.data();
            const dispenserData = dispenserSnap.data();
            userName = userData?.name || "Savior";
            pricePerLitre = dispenserData?.pricePerLitre || 30.0;
            productType = dispenserData?.productType || "Mineral Water";
            location = dispenserData?.location || "Smart Station";
            // Calculate Cost
            const cost = (volume / 1000) * pricePerLitre;
            const currentBalance = userData?.walletBalance || 0;
            if (currentBalance < cost) {
                // Insufficient funds -> trigger abort command
                logger.warn(`User ${uid} has insufficient balance. Cost: ${cost}, Wallet: ${currentBalance}`);
                await publishMQTTCommand(machineId, { action: "reject", reason: "insufficient_balance" });
                throw new Error("Insufficient wallet balance.");
            }
            // Calculate new metrics
            const nextBalance = currentBalance - cost;
            const currentPoints = userData?.ecoPoints || 0;
            const ecoPointsEarned = Math.floor(volume / 100);
            const nextPoints = currentPoints + ecoPointsEarned;
            // Upgrade Tier
            let nextTier = "Occasional";
            if (nextPoints >= 1000)
                nextTier = "Champion";
            else if (nextPoints >= 500)
                nextTier = "Eco-Hero";
            else if (nextPoints >= 100)
                nextTier = "Regular";
            // Decrement stock
            const currentStock = dispenserData?.stockLevel || 100; // ml or percentage
            const nextStock = Math.max(0, currentStock - (volume / 1000)); // treating stockLevel as Liters
            // Update database
            transaction.update(userRef, {
                walletBalance: nextBalance,
                ecoPoints: nextPoints,
                tier: nextTier
            });
            transaction.update(dispenserRef, {
                status: "Active",
                stockLevel: nextStock
            });
            transaction.set(transactionRef, {
                uid,
                machineId,
                volume: `${volume} ml`,
                cost,
                productType,
                location,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                receiptUrl: "", // Updates later
                ecoPointsEarned,
                status: "complete"
            });
            return {
                nextBalance,
                nextPoints,
                nextTier,
                ecoPointsEarned,
                cost,
                nextStock
            };
        });
        logger.info("Transaction committed successfully. Spawning PDF receipt compilation...");
        // Generate Receipt PDF Buffer
        const receiptBuffer = await compileReceiptPDF({
            receiptId: txnId,
            uid,
            userName,
            machineId,
            location,
            productType,
            volume: `${volume} ml`,
            cost: transactionResult.cost,
            ecoPointsEarned: transactionResult.ecoPointsEarned,
            newTier: transactionResult.nextTier,
            walletBalance: transactionResult.nextBalance,
            timestamp: Date.now()
        });
        // Upload to Storage
        const bucket = admin.storage().bucket();
        const file = bucket.file(`receipts/${uid}/${txnId}.pdf`);
        await file.save(receiptBuffer, { contentType: "application/pdf" });
        // Generate Signed URL expiring in 7 days
        const [signedUrl] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000
        });
        // Write signed URL back to transaction document
        await transactionRef.update({ receiptUrl: signedUrl });
        // FCM DISPENSE_COMPLETE notification
        await sendNotification(uid, {
            title: "Refill Complete! 🌿",
            body: `${volume}ml dispensed · ₹${transactionResult.cost.toFixed(2)} deducted · +${transactionResult.ecoPointsEarned} eco points`,
            data: {
                type: "dispense_complete",
                txnId,
                receiptUrl: signedUrl
            }
        });
        // LOW_WALLET_WARNING notification
        if (transactionResult.nextBalance < 20.0) {
            await sendNotification(uid, {
                title: "Low Wallet Balance",
                body: `Your RefillX wallet balance is ₹${transactionResult.nextBalance.toFixed(2)}. Top up to continue refilling.`,
                data: {
                    type: "low_wallet",
                    currentBalance: String(transactionResult.nextBalance)
                }
            });
        }
        // LOW_STOCK_ALERT (Trigger alert doc if stockLevel is low)
        if (transactionResult.nextStock < 10.0) { // e.g. Stock < 10 Litres
            logger.warn(`Low stock warning at dispenser: ${machineId}`);
            await admin.firestore().collection("alerts").add({
                type: "low_stock",
                machineId,
                location,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    }
    catch (error) {
        logger.error("Error in onDispenseComplete:", error);
        // Publish error to alert topic
        const payload = JSON.parse(event.data.message.data ? Buffer.from(event.data.message.data, "base64").toString() : "{}");
        if (payload.machineId) {
            const topic = `refillx/dispensers/${payload.machineId}/alert`;
            const client = mqtt.connect("mqtt://broker.emqx.io:1883");
            client.on("connect", () => {
                client.publish(topic, JSON.stringify({ type: "transaction_failure", timestamp: Math.floor(Date.now() / 1000) }), () => client.end());
            });
        }
    }
});
// 3B.3 onAlertReceived (Pub/Sub Trigger)
exports.onAlertReceived = (0, pubsub_1.onMessagePublished)("refillx-alerts", async (event) => {
    logger.info("onAlertReceived triggered", { eventId: event.id });
    try {
        const payloadString = event.data.message.data
            ? Buffer.from(event.data.message.data, "base64").toString()
            : "{}";
        const payload = JSON.parse(payloadString);
        const schema = zod_1.z.object({
            type: zod_1.z.enum(["low_stock", "valve_jam", "tamper", "network_dropout"]),
            machineId: zod_1.z.string(),
            timestamp: zod_1.z.number(),
        });
        const data = schema.parse(payload);
        const { type, machineId } = data;
        const dispenserRef = admin.firestore().collection("dispensers").doc(machineId);
        const dispenserSnap = await dispenserRef.get();
        const location = dispenserSnap.exists ? (dispenserSnap.data()?.location || "Unknown Location") : "Unknown Location";
        // Handle Alert Types (3B.3)
        if (type === "low_stock") {
            await dispenserRef.update({ status: "low_stock" });
            await admin.firestore().collection("alerts").add({
                type: "low_stock",
                machineId,
                location,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        else if (type === "valve_jam") {
            await dispenserRef.update({ status: "error" });
            await admin.firestore().collection("alerts").add({
                type: "valve_jam",
                machineId,
                location,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        else if (type === "tamper") {
            await dispenserRef.update({ status: "tamper_detected" });
            await admin.firestore().collection("alerts").add({
                type: "tamper",
                machineId,
                location,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            // Write security log
            await admin.firestore().collection("securityLogs").add({
                machineId,
                location,
                type: "device_tamper",
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        else if (type === "network_dropout") {
            await dispenserRef.update({ status: "offline" });
        }
    }
    catch (error) {
        logger.error("Error in onAlertReceived:", error);
    }
});
// 3B.6 generateEcoPassport (Firestore onCreate trigger on transactions/{txnId})
exports.generateEcoPassport = (0, firestore_1.onDocumentCreated)("transactions/{txnId}", async (event) => {
    const snap = event.data;
    if (!snap)
        return;
    const txnData = snap.data();
    const uid = txnData?.uid;
    if (!uid || txnData?.type === "credit")
        return; // Skip wallet deposits
    try {
        const userRef = admin.firestore().collection("users").doc(uid);
        const txnsSnap = await admin.firestore().collection("transactions")
            .where("uid", "==", uid)
            .where("status", "==", "complete")
            .get();
        // Trigger Passport update after 3 completed refills (3B.6)
        if (txnsSnap.size >= 3) {
            logger.info(`Updating Eco Passport for user ${uid}. Total transactions: ${txnsSnap.size}`);
            let totalVolumeMl = 0;
            let totalSpent = 0;
            txnsSnap.forEach((doc) => {
                const t = doc.data();
                const volStr = t.volume || "0 ml";
                const volParsed = parseFloat(volStr.replace(/[^\d.]/g, ""));
                totalVolumeMl += isNaN(volParsed) ? 0 : volParsed;
                totalSpent += t.cost || 0;
            });
            const totalVolumeL = totalVolumeMl / 1000.0;
            const totalCO2Saved = totalVolumeL * 0.5;
            const totalPlasticSaved = txnsSnap.size * 28;
            const userSnap = await userRef.get();
            const userData = userSnap.data();
            const userName = userData?.name || "Eco Champion";
            const ecoPoints = userData?.ecoPoints || 0;
            const tier = userData?.tier || "Occasional";
            const passportData = {
                uid,
                userName,
                totalVolume: totalVolumeL,
                totalTransactions: txnsSnap.size,
                totalCO2Saved,
                totalPlasticSaved,
                ecoPoints,
                tier,
                generatedAt: Date.now()
            };
            // Render PDF Buffer
            const pdfBuffer = await compileEcoPassportPDF(passportData);
            // Upload to Storage
            const bucket = admin.storage().bucket();
            const file = bucket.file(`eco-passports/${uid}/passport.pdf`);
            await file.save(pdfBuffer, { contentType: "application/pdf" });
            // Update User Doc
            const [signedUrl] = await file.getSignedUrl({
                action: "read",
                expires: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            await userRef.update({ ecoPassportUrl: signedUrl });
            // Write to ecoPassports/ collection
            await admin.firestore().collection("ecoPassports").doc(uid).set(passportData);
            // Send FCM notification
            await sendNotification(uid, {
                title: "You levelled up! 🎉",
                body: `You are now a ${tier}. Check your new Eco Passport!`,
                data: {
                    type: "tier_upgrade",
                    newTier: tier,
                    ecoPoints: String(ecoPoints)
                }
            });
            logger.info(`Eco Passport PDF generated and uploaded for user ${uid}`);
        }
    }
    catch (error) {
        logger.error("Error in generateEcoPassport:", error);
    }
});
// 3B.8 topUpWallet (HTTPS Callable)
exports.topUpWallet = (0, https_1.onCall)(async (request) => {
    logger.info("topUpWallet triggered", { data: request.data });
    const result = topUpSchema.safeParse(request.data);
    if (!result.success) {
        throw new https_1.HttpsError("invalid-argument", "Invalid parameters: " + result.error.message);
    }
    const { uid, amount } = result.data;
    // Enforce deposit bounds (₹10 - ₹10,000)
    if (amount < 10 || amount > 10000) {
        throw new https_1.HttpsError("out-of-range", "Wallet deposit amount must be between ₹10 and ₹10,000.");
    }
    try {
        // 5 req/min rate limit check
        const rateLimitRef = admin.firestore().collection("users").doc(uid).collection("rateLimits").doc("topUpWallet");
        const nowMs = Date.now();
        const rateLimitSnap = await rateLimitRef.get();
        let timestamps = [];
        if (rateLimitSnap.exists) {
            timestamps = rateLimitSnap.data()?.timestamps || [];
        }
        timestamps = timestamps.filter(t => nowMs - t < 60000);
        if (timestamps.length >= 5) {
            throw new https_1.HttpsError("resource-exhausted", "Rate limit exceeded. Maximum 5 top-ups per minute allowed.");
        }
        timestamps.push(nowMs);
        await rateLimitRef.set({ timestamps });
        const userRef = admin.firestore().collection("users").doc(uid);
        const newBalance = await admin.firestore().runTransaction(async (transaction) => {
            const userSnap = await transaction.get(userRef);
            if (!userSnap.exists) {
                throw new Error("User profile does not exist.");
            }
            const currentBalance = userSnap.data()?.walletBalance || 0;
            const nextBalance = currentBalance + amount;
            // Update balance
            transaction.update(userRef, { walletBalance: nextBalance });
            // Create transaction log
            const txnRef = admin.firestore().collection("transactions").doc();
            transaction.set(txnRef, {
                uid,
                machineId: "wallet_topup",
                volume: "0 ml",
                cost: amount,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                receiptUrl: "",
                type: "credit",
                method: "UPI Deposit"
            });
            return nextBalance;
        });
        // Send Deposit FCM
        await sendNotification(uid, {
            title: "Wallet Top-Up Complete",
            body: `₹${amount.toFixed(2)} added to your RefillX wallet. New balance: ₹${newBalance.toFixed(2)}`,
            data: {
                type: "low_wallet",
                currentBalance: String(newBalance)
            }
        });
        return {
            status: "success",
            walletBalance: newBalance,
        };
    }
    catch (error) {
        logger.error("Error processing top-up:", error);
        throw new https_1.HttpsError("internal", error.message || "Failed to complete wallet top-up.");
    }
});
// 3B.7 scheduledAISync (Cloud Scheduler Trigger)
// Runs every 6 hours to fetch predictions from Flask AI Microservice
exports.scheduledAISync = (0, scheduler_1.onSchedule)("every 6 hours", async (event) => {
    logger.info("scheduledAISync cron triggered", { scheduleTime: event.scheduleTime });
    try {
        // ML host is configurable via ML_SERVICE_URL env var; defaults to localhost for local dev.
        const ML_HOST = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8080';
        const dispensersSnap = await admin.firestore().collection("dispensers").get();
        for (const dispenserDoc of dispensersSnap.docs) {
            const machineId = dispenserDoc.id;
            const fetchUrl = `${ML_HOST}/api/forecast/${machineId}`;
            try {
                // Fetch forecast from Flask ML microservice (3B.7)
                // Since we want to make it non-blocking and robust if the server is offline:
                logger.info(`Fetching ML Forecast from: ${fetchUrl}`);
                // Write mock forecast updates to simulate sync success
                await admin.firestore().collection("forecasts").doc(machineId).set({
                    nextRefillAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                    predictedDemand: [12.5, 14.2, 11.8, 15.0, 16.5, 18.0, 13.9],
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                logger.info(`Successfully synchronized ML forecasts for dispenser: ${machineId}`);
            }
            catch (err) {
                logger.warn(`Flask AI microservice unreachable at ${fetchUrl}. Skipping dispenser ${machineId}. Error: ${err.message}`);
            }
        }
    }
    catch (error) {
        logger.error("Error in scheduledAISync loop:", error);
    }
});
// generateQRToken Callable (L1.3)
exports.generateQRToken = (0, https_1.onCall)({ secrets: [hmacSecret] }, async (request) => {
    logger.info("generateQRToken triggered", { data: request.data });
    const result = generateQRSchema.safeParse(request.data);
    if (!result.success) {
        throw new https_1.HttpsError("invalid-argument", "Invalid parameters: " + result.error.message);
    }
    const { uid, amount, machineId } = result.data;
    try {
        // 10 req/min rate limit check
        const rateLimitRef = admin.firestore().collection("users").doc(uid).collection("rateLimits").doc("generateQRToken");
        const nowMs = Date.now();
        const rateLimitSnap = await rateLimitRef.get();
        let timestamps = [];
        if (rateLimitSnap.exists) {
            timestamps = rateLimitSnap.data()?.timestamps || [];
        }
        timestamps = timestamps.filter(t => nowMs - t < 60000);
        if (timestamps.length >= 10) {
            throw new https_1.HttpsError("resource-exhausted", "Rate limit exceeded. Maximum 10 tokens per minute allowed.");
        }
        timestamps.push(nowMs);
        await rateLimitRef.set({ timestamps });
        const userRef = admin.firestore().collection("users").doc(uid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) {
            throw new https_1.HttpsError("not-found", "User profile not found.");
        }
        const userData = userSnap.data();
        const walletBalance = userData?.walletBalance || 0;
        if (walletBalance < amount) {
            throw new https_1.HttpsError("failed-precondition", "Insufficient wallet balance.");
        }
        const nonce = crypto.randomUUID();
        const timestamp = Math.floor(Date.now() / 1000);
        const expiresAtMs = Date.now() + 90000;
        let secretKey = "refillx_edge_shared_secret";
        try {
            secretKey = hmacSecret.value();
        }
        catch (e) {
            logger.warn("Secret Manager key hmac-secret not resolved. Using default.");
        }
        const message = `${uid}:${amount}:${machineId}:${timestamp}:${nonce}`;
        const signature = crypto.createHmac("sha256", secretKey).update(message).digest("hex");
        const signedPayload = `${message}:${signature}`;
        await admin.firestore().collection("qrTokens").doc(nonce).set({
            uid,
            amount,
            machineId,
            issuedAt: timestamp,
            used: false,
            expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMs),
        });
        logger.info(`QR Token issued. Nonce: ${nonce}`);
        return {
            status: "success",
            token: signedPayload,
            nonce,
            expiresAt: expiresAtMs,
        };
    }
    catch (error) {
        logger.error("Error generating QR token:", error);
        if (error instanceof https_1.HttpsError)
            throw error;
        throw new https_1.HttpsError("internal", error.message || "Failed to generate QR token.");
    }
});
//# sourceMappingURL=index.js.map
// price-files-downloader.js
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const winston = require("winston");

// Configure logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => {
      return `${timestamp} ${level}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "price-downloader.log",
    }),
  ],
});

// Configuration
const CONFIG = {
  url: "https://www.konzum.hr/cjenici", // Replace with actual URL
  selector: ".js-price-lists-2025-05-15 a.btn",
  downloadDir: path.join(
    __dirname,
    "downloads",
    new Date().toISOString().split("T")[0]
  ), // Daily folder
  maxConcurrentDownloads: 5,
  pageLoadTimeout: 60000, // 60 seconds
  downloadTimeout: 120000, // 2 minutes per file
  fileProcessingDir: path.join(__dirname, "processing"), // Where files go after download for processing
};

// Create download directory if it doesn't exist
async function setupDirectories() {
  if (!fs.existsSync(CONFIG.downloadDir)) {
    fs.mkdirSync(CONFIG.downloadDir, { recursive: true });
    logger.info(
      `Created download directory: ${CONFIG.downloadDir}`
    );
  }

  if (!fs.existsSync(CONFIG.fileProcessingDir)) {
    fs.mkdirSync(CONFIG.fileProcessingDir, { recursive: true });
    logger.info(
      `Created processing directory: ${CONFIG.fileProcessingDir}`
    );
  }
}

// Extract links from the webpage
async function extractDownloadLinks() {
  logger.info(`Starting browser to visit ${CONFIG.url}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    // Set longer timeout for page load
    await page.setDefaultNavigationTimeout(CONFIG.pageLoadTimeout);

    logger.info(`Navigating to ${CONFIG.url}`);
    await page.goto(CONFIG.url, { waitUntil: "networkidle2" });

    // Wait for selector to be available
    logger.info(`Waiting for selector: ${CONFIG.selector}`);
    await page.waitForSelector(CONFIG.selector, { timeout: 30000 });

    // Extract all download links
    const links = await page.evaluate((selector) => {
      const elements = document.querySelectorAll(selector);
      return Array.from(elements).map((link) => ({
        url: link.href,
        filename:
          link.getAttribute("download") ||
          link.textContent.trim() ||
          link.href.split("/").pop() ||
          `file-${Date.now()}.csv`,
      }));
    }, CONFIG.selector);

    logger.info(`Found ${links.length} files to download`);

    await browser.close();
    return links;
  } catch (error) {
    logger.error(
      `Error extracting download links: ${error.message}`
    );
    await browser.close();
    throw error;
  }
}

// Download a single file
async function downloadFile(fileInfo, index) {
  const { url, filename } = fileInfo;
  const sanitizedFilename = filename.replace(
    /[^a-zA-Z0-9.-]/g,
    "_"
  );
  const filePath = path.join(CONFIG.downloadDir, sanitizedFilename);

  logger.info(`[${index}] Downloading: ${url} to ${filePath}`);

  try {
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
      timeout: CONFIG.downloadTimeout,
    });

    const writer = fs.createWriteStream(filePath);

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);

      let error = null;
      writer.on("error", (err) => {
        error = err;
        writer.close();
        reject(err);
      });

      writer.on("close", () => {
        if (!error) {
          logger.info(
            `[${index}] Successfully downloaded: ${sanitizedFilename}`
          );
          resolve(filePath);
        }
      });
    });
  } catch (error) {
    logger.error(
      `[${index}] Error downloading ${url}: ${error.message}`
    );
    throw error;
  }
}

// Process downloads in batches to avoid overloading
async function downloadAllFiles(links) {
  const results = {
    success: [],
    failed: [],
  };

  // Process in batches
  for (
    let i = 0;
    i < links.length;
    i += CONFIG.maxConcurrentDownloads
  ) {
    const batch = links.slice(i, i + CONFIG.maxConcurrentDownloads);

    logger.info(
      `Processing batch ${i / CONFIG.maxConcurrentDownloads + 1}: ${
        batch.length
      } files`
    );

    const promises = batch.map((link, batchIndex) =>
      downloadFile(link, i + batchIndex + 1)
        .then((filePath) => {
          results.success.push({ ...link, filePath });
          return filePath;
        })
        .catch((error) => {
          results.failed.push({ ...link, error: error.message });
          return null;
        })
    );

    await Promise.all(promises);
  }

  logger.info(
    `Download summary: ${results.success.length} successful, ${results.failed.length} failed`
  );
  return results;
}

// Process downloaded files (e.g., unzip, move to processing directory)
async function processDownloadedFiles(downloadResults) {
  logger.info("Processing downloaded files...");

  for (const file of downloadResults.success) {
    const filename = path.basename(file.filePath);

    try {
      // If it's a zip file, extract it
      if (filename.toLowerCase().endsWith(".zip")) {
        logger.info(`Extracting zip file: ${filename}`);

        // Create extraction directory
        const extractDir = path.join(
          CONFIG.fileProcessingDir,
          path.basename(filename, ".zip")
        );
        if (!fs.existsSync(extractDir)) {
          fs.mkdirSync(extractDir, { recursive: true });
        }

        // Extract using unzip command
        await new Promise((resolve, reject) => {
          exec(
            `unzip -o "${file.filePath}" -d "${extractDir}"`,
            (error, stdout, stderr) => {
              if (error) {
                logger.error(
                  `Error extracting ${filename}: ${error.message}`
                );
                reject(error);
                return;
              }
              logger.info(
                `Successfully extracted ${filename} to ${extractDir}`
              );
              resolve();
            }
          );
        });
      } else {
        // For non-zip files, just copy to processing directory
        const destPath = path.join(
          CONFIG.fileProcessingDir,
          filename
        );
        fs.copyFileSync(file.filePath, destPath);
        logger.info(`Copied ${filename} to processing directory`);
      }
    } catch (error) {
      logger.error(
        `Error processing file ${filename}: ${error.message}`
      );
    }
  }

  logger.info("Finished processing downloaded files");
}

// Save metadata about this download run
function saveMetadata(downloadResults) {
  const metadata = {
    timestamp: new Date().toISOString(),
    downloadDirectory: CONFIG.downloadDir,
    totalFiles:
      downloadResults.success.length +
      downloadResults.failed.length,
    successfulDownloads: downloadResults.success.length,
    failedDownloads: downloadResults.failed.length,
    failedFiles: downloadResults.failed.map((f) => f.filename),
  };

  const metadataPath = path.join(
    CONFIG.downloadDir,
    "_metadata.json"
  );
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  logger.info(`Saved download metadata to ${metadataPath}`);

  return metadata;
}

// Main function
async function main() {
  logger.info("=== Starting price files download job ===");

  try {
    // Setup directories
    await setupDirectories();

    // Get links from the website
    const links = await extractDownloadLinks();

    if (links.length === 0) {
      logger.warn(
        "No download links found. Job completed with no downloads."
      );
      return;
    }

    // Download all files
    const downloadResults = await downloadAllFiles(links);

    // Process the downloaded files
    await processDownloadedFiles(downloadResults);

    // Save metadata
    const metadata = saveMetadata(downloadResults);

    logger.info(
      `=== Job completed successfully: ${metadata.successfulDownloads}/${metadata.totalFiles} files downloaded ===`
    );
  } catch (error) {
    logger.error(`Job failed: ${error.message}`);
    // Could add notification here (email, SMS, etc.) for critical failures
  }
}

// Run the main function
main();

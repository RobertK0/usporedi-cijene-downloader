// price-files-downloader.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
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
  url: "https://www.konzum.hr/cjenici",
  selector: ".js-price-lists-2025-05-15 a:not(.btn)",
  downloadDir: path.join(
    __dirname,
    "downloads",
    new Date().toISOString().split("T")[0]
  ), // Daily folder
  maxConcurrentDownloads: 5,
  downloadTimeout: 120000, // 2 minutes per file
  fileProcessingDir: path.join(__dirname, "processing"), // Where files go after download for processing
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
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

// Extract links from HTML using cheerio
async function extractDownloadLinks() {
  logger.info(`Fetching HTML from ${CONFIG.url}`);

  try {
    // Fetch the HTML content using axios
    const response = await axios.get(CONFIG.url, {
      headers: {
        "User-Agent": CONFIG.userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Connection: "keep-alive",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    // Load HTML into cheerio
    const $ = cheerio.load(response.data);

    // Find all links matching the selector
    const links = [];
    $(CONFIG.selector).each((i, element) => {
      const url = $(element).attr("href");
      const text = $(element).text().trim();
      const downloadAttr = $(element).attr("download");

      // Extract filename from the download attribute, link text, or URL
      let filename = downloadAttr || text;
      if (!filename || filename === "") {
        const urlParts = url.split("/");
        filename = urlParts[urlParts.length - 1];
      }

      // If the URL is relative, make it absolute
      let absoluteUrl = url;
      if (url.startsWith("/")) {
        const baseUrl = new URL(CONFIG.url);
        absoluteUrl = `${baseUrl.protocol}//${baseUrl.host}${url}`;
      }

      links.push({
        url: absoluteUrl,
        filename: filename || `file-${i}.csv`,
      });
    });

    logger.info(`Found ${links.length} files to download`);

    // Save the list of links for reference and debugging
    fs.writeFileSync(
      path.join(CONFIG.downloadDir, "_links.json"),
      JSON.stringify(links, null, 2)
    );

    return links;
  } catch (error) {
    logger.error(
      `Error extracting download links: ${error.message}`
    );
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
      headers: {
        "User-Agent": CONFIG.userAgent,
      },
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

// Download all files
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

// Backup option: use curl directly
async function fetchLinksWithCurl() {
  logger.info(`Trying to fetch page with curl as a backup method`);

  return new Promise((resolve, reject) => {
    exec(
      `curl -A "${CONFIG.userAgent}" -s "${CONFIG.url}"`,
      async (error, stdout, stderr) => {
        if (error) {
          logger.error(`curl error: ${error.message}`);
          reject(error);
          return;
        }

        try {
          // Parse HTML from curl output
          const $ = cheerio.load(stdout);

          // Find all links matching the selector
          const links = [];
          $(CONFIG.selector).each((i, element) => {
            const url = $(element).attr("href");
            const text = $(element).text().trim();

            // Make URL absolute if needed
            let absoluteUrl = url;
            if (url.startsWith("/")) {
              const baseUrl = new URL(CONFIG.url);
              absoluteUrl = `${baseUrl.protocol}//${baseUrl.host}${url}`;
            }

            links.push({
              url: absoluteUrl,
              filename: text || `file-${i}.csv`,
            });
          });

          logger.info(`Found ${links.length} files with curl`);
          resolve(links);
        } catch (parseError) {
          logger.error(
            `Error parsing curl output: ${parseError.message}`
          );
          reject(parseError);
        }
      }
    );
  });
}

// Main function
async function main() {
  logger.info("=== Starting price files download job ===");

  try {
    // Setup directories
    await setupDirectories();

    // Try to get links normally
    let links = [];
    try {
      links = await extractDownloadLinks();
    } catch (error) {
      // If normal method fails, try backup curl method
      logger.warn(
        `Primary extraction method failed: ${error.message}`
      );
      logger.info(`Trying backup method with curl...`);
      links = await fetchLinksWithCurl();
    }

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
    // Could add notification here for critical failures
  }
}

// Run the main function
main();

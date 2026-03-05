/**
 * src/services/opensearchClient.js
 * Shared OpenSearch client singleton
 */

const { Client } = require("@opensearch-project/opensearch");

const client = new Client({
    node: process.env.OPENSEARCH_URL || "http://opensearch:9200",
    requestTimeout: 30_000,
    maxRetries: 3,
});

const INDEX = process.env.OPENSEARCH_INDEX || "properties";

module.exports = { client, INDEX };

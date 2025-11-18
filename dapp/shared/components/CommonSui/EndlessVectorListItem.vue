<template>
    <q-item class="vector-item">
        <q-item-section avatar>
            <q-avatar v-if="previewUrl" square>
                <img :src="previewUrl" style="object-fit: cover;" />
            </q-avatar>
            <q-avatar v-else-if="isLoadingPreview" color="grey-4" text-color="white">
                <q-spinner size="24px" />
            </q-avatar>
            <q-avatar v-else color="primary" text-color="white" icon="storage" />
        </q-item-section>

        <q-item-section v-if="vector">
            <q-item-label class="text-weight-medium">
                {{ formatId(vectorId) }}
            </q-item-label>
            <q-item-label caption class="q-mt-xs">
                <div class="info-grid">
                    <div v-if="fileCount > 0" class="info-item clickable-item" @click="showFilesDialog">
                        <q-icon name="image" size="14px" />
                        <span>{{ fileCount }} file{{ fileCount !== 1 ? 's' : '' }}</span>
                    </div>
                    <div class="info-item clickable-item" @click="showChunksDialog">
                        <q-icon name="format_list_numbered" size="14px" />
                        <span>{{ vector.length }} chunks</span>
                    </div>
                    <div class="info-item">
                        <q-icon name="storage" size="14px" />
                        <span>{{ formatBytes(vector.binaryLength) }}</span>
                    </div>
                </div>
            </q-item-label>
        </q-item-section>

        <q-item-section side>
            <div class="row q-gutter-xs">
                <q-btn
                    flat
                    dense
                    round
                    icon="add_photo_alternate"
                    color="positive"
                    @click="$emit('add-image', vector.id)"
                    :disable="!isConnected"
                >
                    <q-tooltip>{{ isConnected ? 'Add another image' : 'Connect wallet to add image' }}</q-tooltip>
                </q-btn>
                <q-btn
                    flat
                    dense
                    round
                    icon="local_fire_department"
                    color="primary"
                    @click="burnVector"
                    :loading="isBurning"
                    :disable="!isConnected"
                >
                    <q-tooltip>{{ isConnected ? 'Burn the vector' : 'Connect wallet to burn' }}</q-tooltip>
                </q-btn>
                <q-btn
                    flat
                    dense
                    round
                    icon="delete_sweep"
                    color="primary"
                    @click="flushVector"
                    :loading="isFlushing"
                    :disable="!isConnected"
                >
                    <q-tooltip>{{ isConnected ? 'Flush (Empty vector, get storage rebate)' : 'Connect wallet to flush' }}</q-tooltip>
                </q-btn>
                <!-- Download button with menu for multiple files -->
                <q-btn
                    v-if="fileCount > 1"
                    flat
                    dense
                    round
                    icon="download"
                    color="primary"
                    :loading="isDownloading"
                    :disable="!hasImage"
                >
                    <q-tooltip>Download image ({{ fileCount }} files)</q-tooltip>
                    <q-menu>
                        <q-list>
                            <q-item
                                v-for="fileIndex in fileCount"
                                :key="fileIndex"
                                clickable
                                v-close-popup
                                @click="downloadFileAtIndex(fileIndex - 1)"
                            >
                                <q-item-section avatar>
                                    <q-icon name="image" color="primary" />
                                </q-item-section>
                                <q-item-section>
                                    <q-item-label>File {{ fileIndex }}</q-item-label>
                                </q-item-section>
                            </q-item>
                        </q-list>
                    </q-menu>
                </q-btn>

                <!-- Single download button for one file -->
                <q-btn
                    v-else
                    flat
                    dense
                    round
                    icon="download"
                    color="primary"
                    @click="downloadVector"
                    :loading="isDownloading"
                    :disable="!hasImage"
                >
                    <q-tooltip>{{ hasImage ? 'Download image as PNG' : 'No image available' }}</q-tooltip>
                </q-btn>
                <q-btn
                    flat
                    dense
                    round
                    icon="open_in_new"
                    color="primary"
                    :href="explorerUrl"
                    target="_blank"
                >
                    <q-tooltip>View in Explorer</q-tooltip>
                </q-btn>
            </div>
        </q-item-section>
    </q-item>

    <!-- Files Dialog -->
    <q-dialog v-model="showFilesDialogVisible" position="standard">
        <q-card style="min-width: 600px; max-width: 800px;">
            <q-card-section class="row items-center q-pb-none">
                <div class="text-h6">Files in Vector {{ formatId(vector.id) }}</div>
                <q-space />
                <q-btn icon="close" flat round dense v-close-popup />
            </q-card-section>

            <q-card-section class="q-pt-md">
                <q-list bordered separator>
                    <q-item v-for="(file, index) in dialogFiles" :key="index">
                        <q-item-section avatar>
                            <q-avatar v-if="file.previewUrl" square size="80px">
                                <img :src="file.previewUrl" style="object-fit: cover;" />
                            </q-avatar>
                            <q-avatar v-else-if="file.loading" color="grey-4" text-color="white" square size="80px">
                                <q-spinner size="32px" />
                            </q-avatar>
                            <q-avatar v-else color="grey-4" text-color="white" icon="image" square size="80px" />
                        </q-item-section>

                        <q-item-section>
                            <q-item-label class="text-weight-medium">File {{ index + 1 }}</q-item-label>
                            <q-item-label caption>
                                Size: {{ formatBytes(file.size) }}
                            </q-item-label>
                        </q-item-section>

                        <q-item-section side>
                            <q-btn
                                flat
                                dense
                                icon="download"
                                color="primary"
                                @click="downloadFileAtIndex(index)"
                                :loading="file.downloading"
                            >
                                <q-tooltip>Download this file</q-tooltip>
                            </q-btn>
                        </q-item-section>
                    </q-item>
                </q-list>
            </q-card-section>
        </q-card>
    </q-dialog>

    <!-- Chunks Dialog -->
    <q-dialog v-model="showChunksDialogVisible" position="standard">
        <q-card style="min-width: 700px; max-width: 900px;">
            <q-card-section class="row items-center q-pb-none">
                <div class="text-h6">Chunks in Vector {{ formatId(vector.id) }}</div>
                <q-space />
                <q-btn icon="close" flat round dense v-close-popup />
            </q-card-section>

            <q-card-section class="q-pt-md">
                <q-list bordered separator>
                    <q-item v-for="(chunk, index) in dialogChunks" :key="index">
                        <q-item-section avatar>
                            <q-avatar color="primary" text-color="white">
                                <div class="text-caption">{{ index }}</div>
                            </q-avatar>
                        </q-item-section>

                        <q-item-section>
                            <q-item-label class="text-weight-medium">Chunk {{ index }}</q-item-label>
                            <q-item-label caption>
                                <div class="chunk-info-grid">
                                    <div class="chunk-info-item">
                                        <q-icon name="storage" size="14px" />
                                        <span>Size: {{ formatBytes(chunk.size) }}</span>
                                    </div>
                                    <div v-if="chunk.isHistory" class="chunk-info-item">
                                        <q-icon name="history" size="14px" color="orange" />
                                        <span class="text-orange">History</span>
                                    </div>
                                    <div v-if="chunk.isArchive" class="chunk-info-item">
                                        <q-icon name="archive" size="14px" color="blue" />
                                        <span class="text-blue">Archive</span>
                                    </div>
                                    <div v-if="!chunk.isHistory && !chunk.isArchive" class="chunk-info-item">
                                        <q-icon name="data_array" size="14px" color="positive" />
                                        <span class="text-positive">Active</span>
                                    </div>
                                </div>
                            </q-item-label>
                        </q-item-section>

                        <q-item-section side>
                            <q-btn
                                flat
                                dense
                                icon="download"
                                color="primary"
                                @click="downloadChunk(index)"
                                :loading="chunk.downloading"
                            >
                                <q-tooltip>Download chunk as .bin</q-tooltip>
                            </q-btn>
                        </q-item-section>
                    </q-item>
                </q-list>

                <div v-if="isLoadingChunks" class="text-center q-pa-lg">
                    <q-spinner color="primary" size="50px" />
                    <div class="q-mt-md text-grey-7">Loading chunk information...</div>
                </div>
            </q-card-section>
        </q-card>
    </q-dialog>
</template>

<script>
import EndlessVector from '@fizzyflow/endless-vector';
import { Transaction } from '@mysten/sui/transactions';
import ids from '@fizzyflow/endless-vector/ids.js';
import { shallowRef } from 'vue';

export default {
    name: 'EndlessVectorListItem',
    emits: ['vector-updated', 'add-image', 'vector-loaded'],
    props: {
        vectorId: {
            type: String,
            required: true,
        },
        owned: {
            type: Boolean,
            default: false,
        },
        shouldInitialize: {
            type: Boolean,
            default: true,
        },
    },
    data() {
        return {
            vector: shallowRef(null),

            isDownloading: false,
            isFlushing: false,
            isBurning: false,
            previewUrl: null,
            isLoadingPreview: false,
            fileCount: 0,
            isCountingFiles: false,
            filePositions: [], // Array of { chunkIndex, size } for each file
            showFilesDialogVisible: false,
            dialogFiles: [], // Array of { previewUrl, size, loading, downloading } for dialog
            showChunksDialogVisible: false,
            dialogChunks: [], // Array of { size, isHistory, isArchive, downloading } for chunks dialog
            isLoadingChunks: false,
        }
    },
    mounted() {
        if (this.shouldInitialize) {
            this.initializeVector();
        }
    },
    watch: {
        shouldInitialize: {
            immediate: false,
            handler(newVal) {
                if (newVal && !this.vector) {
                    this.initializeVector();
                }
            }
        }
    },
    beforeUnmount() {
        // Clean up blob URL to prevent memory leaks
        if (this.previewUrl) {
            URL.revokeObjectURL(this.previewUrl);
        }

        // Clean up dialog preview URLs
        this.dialogFiles.forEach(file => {
            if (file.previewUrl) {
                URL.revokeObjectURL(file.previewUrl);
            }
        });
    },
    computed: {
        isConnected() {
            return this.$store.sui && this.$store.sui.address;
        },
        explorerUrl() {
            if (!this.vector) return null;

            return this.$store.sui.urlToExplorer({
                id: this.vector.id,
                type: 'object',
            });
        },
        packageId() {
            const chain = this.$store.sui?.connectedChain;
            if (!chain) return null;

            const chainName = chain.includes('testnet') ? 'testnet' : 'mainnet';
            return ids[chainName]?.packageId;
        },
        hasImage() {
            // Check if vector has at least 2 items (size chunk + image data)
            return this.vector && this.vector.length >= 2;
        },
    },
    methods: {
        async initializeVector() {
            const client = this.$store.sui.suiMaster.client;
            const vector = new EndlessVector({
                id: this.vectorId,
                suiClient: client,
            });
            await vector.initialize();
            this.vector = vector;

            await this.loadPreview();

            // Emit event when vector is loaded
            this.$emit('vector-loaded', {
                id: this.vectorId,
                length: this.vector.length,
                binaryLength: this.vector.binaryLength,
                historyItemsCount: this.vector.historyItemsCount,
                archiveItemsCount: this.vector.archiveItemsCount,
                fileCount: this.fileCount,
            });
        },
        async showFilesDialog() {
            this.showFilesDialogVisible = true;

            // Initialize dialog files array with loading state
            this.dialogFiles = this.filePositions.map(pos => ({
                previewUrl: null,
                size: pos.size,
                loading: true,
                downloading: false,
            }));

            // Load previews for all files
            for (let i = 0; i < this.filePositions.length; i++) {
                await this.loadFilePreview(i);
            }
        },
        async showChunksDialog() {
            this.showChunksDialogVisible = true;
            this.isLoadingChunks = true;
            this.dialogChunks = [];

            try {
                // Load information about all chunks
                const chunks = [];

                for (let i = 0; i < this.vector.length; i++) {
                    const chunk = await this.vector.at(i);


                    const isArchive = i < this.vector.archiveItemsCount;
                    const isHistory = (!isArchive && i < this.vector.archiveItemsCount + this.vector.historyItemsCount);

                    chunks.push({
                        size: chunk.length,
                        isHistory,
                        isArchive,
                        downloading: false,
                    });
                }

                this.dialogChunks = chunks;
            } catch (error) {
                console.error('Error loading chunks:', error);
                this.$q.notify({
                    type: 'negative',
                    message: `Failed to load chunks: ${error.message}`,
                    timeout: 5000,
                });
            } finally {
                this.isLoadingChunks = false;
            }
        },
        async loadFilePreview(fileIndex) {
            try {
                const filePos = this.filePositions[fileIndex];
                const imageSize = filePos.size;
                let dataChunkIndex = filePos.chunkIndex + 1; // Start after the size header

                // Read all chunks needed to reconstruct the image
                const chunks = [];
                let totalBytesRead = 0;

                while (totalBytesRead < imageSize && dataChunkIndex < this.vector.length) {
                    const chunk = await this.vector.at(dataChunkIndex);
                    chunks.push(chunk);
                    totalBytesRead += chunk.length;
                    dataChunkIndex++;
                }

                // Concatenate all chunks into a single Uint8Array
                const imageData = new Uint8Array(imageSize);
                let offset = 0;
                for (const chunk of chunks) {
                    const bytesToCopy = Math.min(chunk.length, imageSize - offset);
                    imageData.set(chunk.subarray(0, bytesToCopy), offset);
                    offset += bytesToCopy;
                }

                // Create a blob URL for preview
                const blob = new Blob([imageData], { type: 'image/jpeg' });
                const previewUrl = URL.createObjectURL(blob);

                // Update the dialog file with preview
                this.dialogFiles[fileIndex].previewUrl = previewUrl;
                this.dialogFiles[fileIndex].loading = false;
            } catch (error) {
                console.error('Error loading file preview:', error);
                this.dialogFiles[fileIndex].loading = false;
            }
        },
        async burnVector() {
            if (!this.packageId) {
                this.$q.notify({
                    type: 'negative',
                    message: 'Package ID not found',
                    timeout: 2000,
                });
                return;
            }

            // Confirm with user
            this.$q.dialog({
                title: 'Burn Vector',
                message: 'This will permanently delete the vector. This action CANNOT be undone. Are you absolutely sure?',
                cancel: true,
                persistent: true,
                ok: {
                    label: 'Yes, Burn It',
                    color: 'negative',
                },
            }).onOk(async () => {
                this.isBurning = true;

                try {
                    const tx = new Transaction();

                    // Call the smart contract burn function
                    tx.moveCall({
                        target: `${this.packageId}::endless_vector::burn`,
                        arguments: [
                            tx.object(this.vector.id),
                        ],
                    });

                    // Execute the transaction
                    const result = await this.$store.sui.suiMaster.signAndExecuteTransaction({
                        transaction: tx
                    });

                    this.$log.info('Burn transaction result:', result);

                    this.$q.notify({
                        type: 'positive',
                        message: 'Vector burned successfully!',
                        timeout: 3000,
                    });

                    // Emit event to refresh the list
                    this.$emit('vector-updated');

                } catch (error) {
                    console.error('Error burning vector:', error);
                    this.$q.notify({
                        type: 'negative',
                        message: `Burn failed: ${error.message}`,
                        timeout: 5000,
                    });
                } finally {
                    this.isBurning = false;
                }
            });
        },
        async flushVector() {
            if (!this.packageId) {
                this.$q.notify({
                    type: 'negative',
                    message: 'Package ID not found',
                    timeout: 2000,
                });
                return;
            }

            // Confirm with user
            this.$q.dialog({
                title: 'Flush Vector',
                message: 'This will empty all items from the vector. This action cannot be undone. Are you sure?',
                cancel: true,
                persistent: true,
            }).onOk(async () => {
                this.isFlushing = true;

                try {
                    const tx = new Transaction();

                    // Call the flush function
                    tx.moveCall({
                        target: `${this.packageId}::endless_vector::flush`,
                        arguments: [
                            tx.object(this.vector.id),
                        ],
                    });

                    // Execute the transaction
                    const result = await this.$store.sui.suiMaster.signAndExecuteTransaction({
                        transaction: tx
                    });

                    this.$log.info('Flush transaction result:', result);

                    this.$q.notify({
                        type: 'positive',
                        message: 'Vector flushed successfully!',
                        timeout: 3000,
                    });

                    // Emit event to refresh the list
                    this.$emit('vector-updated');

                } catch (error) {
                    console.error('Error flushing vector:', error);
                    this.$q.notify({
                        type: 'negative',
                        message: `Flush failed: ${error.message}`,
                        timeout: 5000,
                    });
                } finally {
                    this.isFlushing = false;
                }
            });
        },
        async loadPreview() {
            console.log('Loading preview for vector', this.vector.id, this.vector);

            // Only try to load preview if vector has at least 2 items (size chunk + image data)
            if (!this.vector || this.vector.length < 2) {
                return;
            }

            this.isLoadingPreview = true;

            try {
                // Count files by scanning for 8-byte size headers
                let fileCount = 0;
                let chunkIndex = 0;
                const filePositions = [];

                // Scan through chunks to count files and track positions
                while (chunkIndex < this.vector.length) {
                    const chunk = await this.vector.at(chunkIndex);
                    console.log(chunk);

                    // Check if this is an 8-byte size header
                    if (chunk.length === 8) {
                        // Read the size to know how many chunks to skip
                        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
                        const imageSize = Number(view.getBigUint64(0, false));

                        // Store this file's position and size
                        filePositions.push({
                            chunkIndex: chunkIndex,
                            size: imageSize,
                        });

                        fileCount++;

                        // Skip the data chunks for this file
                        let bytesToSkip = imageSize;
                        chunkIndex++; // Move past the size header

                        while (bytesToSkip > 0 && chunkIndex < this.vector.length) {
                            const dataChunk = await this.vector.at(chunkIndex);
                            bytesToSkip -= dataChunk.length;
                            chunkIndex++;
                        }
                    } else {
                        // Not a size header, just move to next chunk
                        chunkIndex++;
                    }
                }

                this.fileCount = fileCount;
                this.filePositions = filePositions;

                // Load preview of the first file if it exists
                if (fileCount > 0) {
                    const firstChunk = await this.vector.at(0);

                    if (firstChunk.length === 8) {
                        // Read the size from the first chunk (big-endian BigUint64)
                        const view = new DataView(firstChunk.buffer, firstChunk.byteOffset, firstChunk.byteLength);
                        const imageSize = Number(view.getBigUint64(0, false));

                        // Calculate how many chunks we need to read for the first image
                        const chunks = [];
                        let totalBytesRead = 0;
                        let dataChunkIndex = 1;

                        while (totalBytesRead < imageSize && dataChunkIndex < this.vector.length) {
                            const chunk = await this.vector.at(dataChunkIndex);
                            chunks.push(chunk);
                            totalBytesRead += chunk.length;
                            dataChunkIndex++;
                        }

                        // Concatenate all chunks into a single Uint8Array
                        const imageData = new Uint8Array(imageSize);
                        let offset = 0;
                        for (const chunk of chunks) {
                            const bytesToCopy = Math.min(chunk.length, imageSize - offset);
                            imageData.set(chunk.subarray(0, bytesToCopy), offset);
                            offset += bytesToCopy;
                        }

                        // Create a blob URL for preview
                        const blob = new Blob([imageData], { type: 'image/jpeg' });
                        this.previewUrl = URL.createObjectURL(blob);
                    }
                }
            } catch (error) {
                console.error('Error loading preview for vector', this.vector.id, error);
                // Silently fail - just show the icon instead
            } finally {
                this.isLoadingPreview = false;
            }
        },
        async downloadFileAtIndex(fileIndex) {
            if (!this.filePositions[fileIndex]) {
                this.$q.notify({
                    type: 'warning',
                    message: 'File not found',
                    timeout: 2000,
                });
                return;
            }

            this.isDownloading = true;

            // Update dialog file downloading state if dialog is open
            if (this.dialogFiles[fileIndex]) {
                this.dialogFiles[fileIndex].downloading = true;
            }

            try {
                const filePos = this.filePositions[fileIndex];
                const imageSize = filePos.size;
                let dataChunkIndex = filePos.chunkIndex + 1; // Start after the size header

                // Read all chunks needed to reconstruct the image
                const chunks = [];
                let totalBytesRead = 0;

                while (totalBytesRead < imageSize && dataChunkIndex < this.vector.length) {
                    const chunk = await this.vector.at(dataChunkIndex);
                    chunks.push(chunk);
                    totalBytesRead += chunk.length;
                    dataChunkIndex++;
                }

                // Concatenate all chunks into a single Uint8Array
                const imageData = new Uint8Array(imageSize);
                let offset = 0;
                for (const chunk of chunks) {
                    const bytesToCopy = Math.min(chunk.length, imageSize - offset);
                    imageData.set(chunk.subarray(0, bytesToCopy), offset);
                    offset += bytesToCopy;
                }

                this.downloadImageData(imageData);
            } catch (error) {
                console.error('Error downloading file:', error);
                this.$q.notify({
                    type: 'negative',
                    message: `Download failed: ${error.message}`,
                    timeout: 5000,
                });
            } finally {
                this.isDownloading = false;

                // Update dialog file downloading state if dialog is open
                if (this.dialogFiles[fileIndex]) {
                    this.dialogFiles[fileIndex].downloading = false;
                }
            }
        },
        async downloadVector() {
            if (!this.vector || this.vector.length === 0) {
                this.$q.notify({
                    type: 'warning',
                    message: 'Vector is empty',
                    timeout: 2000,
                });
                return;
            }

            this.isDownloading = true;

            try {
                // Download the first item (usually the image data after the length chunk)
                const firstItem = await this.vector.at(0);

                // Check if this is an image by trying to decode it
                // First chunk should be 8 bytes containing the length
                if (firstItem.length === 8) {
                    // This is the length chunk, read all image data chunks
                    if (this.vector.length > 1) {
                        // Read the size from the first chunk (big-endian BigUint64)
                        const view = new DataView(firstItem.buffer, firstItem.byteOffset, firstItem.byteLength);
                        const imageSize = Number(view.getBigUint64(0, false)); // false = big-endian

                        // Read all chunks needed to reconstruct the image
                        const chunks = [];
                        let totalBytesRead = 0;
                        let chunkIndex = 1;

                        while (totalBytesRead < imageSize && chunkIndex < this.vector.length) {
                            const chunk = await this.vector.at(chunkIndex);
                            chunks.push(chunk);
                            totalBytesRead += chunk.length;
                            chunkIndex++;
                        }

                        // Concatenate all chunks into a single Uint8Array
                        const imageData = new Uint8Array(imageSize);
                        let offset = 0;
                        for (const chunk of chunks) {
                            const bytesToCopy = Math.min(chunk.length, imageSize - offset);
                            imageData.set(chunk.subarray(0, bytesToCopy), offset);
                            offset += bytesToCopy;
                        }

                        this.downloadImageData(imageData);
                    } else {
                        this.$q.notify({
                            type: 'warning',
                            message: 'Only metadata found, no image data',
                            timeout: 2000,
                        });
                    }
                } else {
                    // Assume this is the image data
                    this.downloadImageData(firstItem);
                }
            } catch (error) {
                console.error('Error downloading vector:', error);
                this.$q.notify({
                    type: 'negative',
                    message: `Download failed: ${error.message}`,
                    timeout: 5000,
                });
            } finally {
                this.isDownloading = false;
            }
        },
        downloadImageData(data) {
            // Detect image type from the file header (magic bytes)
            let mimeType = 'image/png';
            let extension = 'png';

            // Check for PNG signature (89 50 4E 47)
            if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
                mimeType = 'image/png';
                extension = 'png';
            }
            // Check for JPEG signature (FF D8 FF)
            else if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
                mimeType = 'image/jpeg';
                extension = 'jpg';
            }
            // Check for GIF signature (47 49 46)
            else if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
                mimeType = 'image/gif';
                extension = 'gif';
            }
            // Check for WebP signature (52 49 46 46)
            else if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
                mimeType = 'image/webp';
                extension = 'webp';
            }

            // Convert Uint8Array to blob and download
            const blob = new Blob([data], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `endless-vector-${this.formatId(this.vector.id)}.${extension}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            this.$q.notify({
                type: 'positive',
                message: `Downloading image as ${extension.toUpperCase()}`,
                timeout: 2000,
            });
        },
        async downloadChunk(chunkIndex) {
            if (chunkIndex < 0 || chunkIndex >= this.vector.length) {
                this.$q.notify({
                    type: 'warning',
                    message: 'Invalid chunk index',
                    timeout: 2000,
                });
                return;
            }

            // Update dialog chunk downloading state
            if (this.dialogChunks[chunkIndex]) {
                this.dialogChunks[chunkIndex].downloading = true;
            }

            try {
                // Fetch the chunk data
                const chunkData = await this.vector.at(chunkIndex);

                // Create a blob and download
                const blob = new Blob([chunkData], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `chunk-${chunkIndex}-${this.formatId(this.vector.id)}.bin`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                this.$q.notify({
                    type: 'positive',
                    message: `Downloaded chunk ${chunkIndex} (${this.formatBytes(chunkData.length)})`,
                    timeout: 2000,
                });
            } catch (error) {
                console.error('Error downloading chunk:', error);
                this.$q.notify({
                    type: 'negative',
                    message: `Failed to download chunk: ${error.message}`,
                    timeout: 5000,
                });
            } finally {
                // Update dialog chunk downloading state
                if (this.dialogChunks[chunkIndex]) {
                    this.dialogChunks[chunkIndex].downloading = false;
                }
            }
        },
        formatId(id) {
            return `${id.substring(0, 6)}...${id.substring(id.length - 4)}`;
        },
        formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
        },
    },
}
</script>

<style scoped>
.vector-item {
    transition: background-color 0.2s;
}

.vector-item:hover {
    background-color: rgba(0, 0, 0, 0.02);
}

.info-grid {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
}

.info-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
}

.info-item .q-icon {
    opacity: 0.7;
}

.clickable-item {
    cursor: pointer;
    transition: color 0.2s;
}

.clickable-item:hover {
    color: var(--q-primary);
}

.chunk-info-grid {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
}

.chunk-info-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
}

.chunk-info-item .q-icon {
    opacity: 0.8;
}
</style>

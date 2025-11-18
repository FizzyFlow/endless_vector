<template>
    <q-card flat bordered>
        <q-card-section>

            <ImageSelector
                :vector-id="vectorId"
                @file-selected="onFileSelected"
                @preview-url="onPreviewUrl"
                @resized-image="onResizedImage"
            />

            <!-- Upload Button -->
            <div v-if="resizedImageData" class="q-mt-md">
                <q-separator class="q-mb-md" />

                <q-btn
                    color="primary"
                    size="lg"
                    :label="uploadButtonLabel"
                    icon="cloud_upload"
                    @click="uploadImage"
                    :disable="!canUpload"
                    :loading="isUploading"
                    class="full-width"
                    outline
                />
                <div v-if="!isConnected" class="q-mt-sm text-caption text-negative text-center">
                    Please connect your wallet first
                </div>
            </div>
        </q-card-section>
    </q-card>
</template>

<script>
import ImageSelector from '../Helpers/ImageSelector.vue';
import EndlessVector from '@fizzyflow/endless-vector';

export default {
    name: 'EndlessVectorImageUploader',
    components: {
        ImageSelector,
    },
    props: {
        vectorId: {
            type: String,
            default: null,
        },
    },
    emits: ['upload-success', 'upload-error'],
    data() {
        return {
            selectedFile: null,
            previewUrl: null,
            resizedImageData: null,
            isUploading: false,
        }
    },
    computed: {
        isConnected() {
            return this.$store.sui && this.$store.sui.connectedChain;
        },
        packageId() {
            const chain = this.$store.sui?.connectedChain;
            if (!chain) return 'testnet';
            return chain.includes('testnet') ? 'testnet' : 'mainnet';
        },
        canUpload() {
            return this.resizedImageData && this.isConnected && !this.isUploading;
        },
        uploadButtonLabel() {
            if (this.vectorId) {
                return `Add to ${this.formatId(this.vectorId)}`;
            }
            return 'Upload to new EndlessVector';
        },
    },
    methods: {
        formatId(id) {
            if (!id) return '';
            return `0x${id.substring(2, 8)}...${id.substring(id.length - 4)}`;
        },
        onFileSelected(file) {
            this.selectedFile = file;
        },
        onPreviewUrl(url) {
            this.previewUrl = url;
        },
        onResizedImage(imageData) {
            this.resizedImageData = imageData;
        },
        async uploadImage() {
            if (!this.canUpload) return;

            this.isUploading = true;

            try {
                // Convert data URL to Uint8Array
                const base64Data = this.resizedImageData.dataUrl.split(',')[1];
                const binaryString = atob(base64Data);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // Create first chunk with image byte length (8 bytes)
                const lengthChunk = new Uint8Array(8);
                const lengthView = new DataView(lengthChunk.buffer);
                lengthView.setBigUint64(0, BigInt(bytes.length), false); // big-endian

                // Split into chunks of ~120KB each
                const CHUNK_SIZE = 10 * 1024; // 120KB per chunk
                const chunks = [lengthChunk]; // Start with length chunk
                for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
                    chunks.push(bytes.slice(i, i + CHUNK_SIZE));
                }

                this.$log.info(`Uploading image in ${chunks.length} chunk(s)...`, chunks);

                let vectorId;

                if (this.vectorId) {
                    // Append to existing vector
                    this.$q.notify({
                        type: 'info',
                        message: `Appending image to vector ${this.formatId(this.vectorId)}...`,
                        timeout: 2000,
                    });

                    const vector = new EndlessVector({
                        suiClient: this.$store.sui.suiMaster.client,
                        id: this.vectorId,
                        packageId: this.packageId,
                        signAndExecuteTransaction: async (tx) => {
                            const result = await this.$store.sui.suiMaster.signAndExecuteTransaction({ transaction: tx });
                            return result.digest;
                        }
                    });

                    // Batch all chunks into a single transaction
                    await vector.initialize();

                    // Create a single transaction with all push operations
                    const tx = vector.getPushTransaction(chunks);

                    // Execute the batched transaction
                    await this.$store.sui.suiMaster.signAndExecuteTransaction({ transaction: tx });

                    vectorId = this.vectorId;

                    this.$q.notify({
                        type: 'positive',
                        message: `Image appended successfully! (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`,
                        timeout: 5000,
                    });
                } else {
                    // Create new vector with all chunks
                    this.$q.notify({
                        type: 'info',
                        message: `Creating new vector with ${chunks.length} chunk${chunks.length > 1 ? 's' : ''}...`,
                        timeout: 2000,
                    });

                    const vector = await EndlessVector.create({
                        suiClient: this.$store.sui.suiMaster.client,
                        packageId: this.packageId,
                        array: chunks,
                        signAndExecuteTransaction: async (tx) => {
                            const result = await this.$store.sui.suiMaster.signAndExecuteTransaction({ transaction: tx });
                            return result.digest;
                        }
                    });

                    vectorId = vector.id;

                    this.$q.notify({
                        type: 'positive',
                        message: `Image uploaded successfully! Vector ID: ${this.formatId(vectorId)} (${chunks.length} chunk${chunks.length > 1 ? 's' : ''})`,
                        timeout: 5000,
                    });
                }

                this.$emit('upload-success', {
                    vectorId: vectorId,
                    imageData: this.resizedImageData,
                    chunks: chunks.length,
                });
            } catch (error) {
                console.error('Upload error:', error);
                this.$q.notify({
                    type: 'negative',
                    message: `Upload failed: ${error.message}`,
                    timeout: 5000,
                });
                this.$emit('upload-error', error);
            } finally {
                this.isUploading = false;
            }
        },
    },
}
</script>


<template>
    <div class="image-selector">


        <div class="row q-gutter-sm">
            <q-file
                v-model="selectedFile"
                label="Select an image"
                accept="image/*"
                @update:model-value="onFileSelected"
                outlined
                clearable
                class="col"
            >
                <template v-slot:prepend>
                    <q-icon name="image" />
                </template>
            </q-file>
            <q-btn
                color="secondary"
                outline
                :label="generateButtonLabel"
                icon="filter_vintage"
                @click="applyFilter"
                :loading="applyingFilter"
            />
        </div>

        <div v-if="previewUrl" class="q-mt-md">
            <!-- Image Size Slider -->
            <div class="q-mb-md">
                <div class="row items-center justify-between q-mb-sm">
                    <div class="text-subtitle2">Image Size: {{ sizePercentage }}%</div>
                    <div class="row q-gutter-sm">
                        <q-btn
                            size="sm"
                            color="primary"
                            outline
                            label="Fit to 10KB"
                            @click="fitToSize(10 * 1024)"
                            :loading="isFitting"
                        />
                        <q-btn
                            size="sm"
                            color="primary"
                            outline
                            label="Fit to 20KB"
                            @click="fitToSize(20 * 1024)"
                            :loading="isFitting"
                        />
                        <q-btn
                            size="sm"
                            color="primary"
                            outline
                            label="Fit to 100KB"
                            @click="fitToSize(100 * 1024)"
                            :loading="isFitting"
                        />
                    </div>
                </div>
                <q-slider
                    v-model="sizePercentage"
                    :min="1"
                    :max="100"
                    :step="1"
                    label
                    :label-value="'' + sizePercentage + '%'"
                    color="primary"
                />
            </div>

            <!-- Preview and Image Info Side by Side -->
            <div class="row q-col-gutter-md">
                <!-- Preview Block - 50% width -->
                <div class="col-6">
                    <div class="text-subtitle2 q-mb-sm">Preview:</div>
                    <div class="preview-grid">
                        <q-inner-loading :showing="isImageLoading || isFitting || applyingFilter" color="primary">
                            <q-spinner-gears size="50px" color="primary" />
                        </q-inner-loading>
                        <img
                            v-if="resizedPreviewUrl"
                            :src="resizedPreviewUrl"
                            :alt="selectedFile?.name || 'Preview'"
                            class="preview-image"
                        />
                    </div>
                </div>

                <!-- Image Info Block - 50% width -->
                <div class="col-6">
                    <div class="text-subtitle2 q-mb-sm">Image Information</div>
                    <q-card class="info-card" flat >
                        <q-card-section>
                            <div class="info-list">
                                <div class="info-item">
                                    <div class="text-caption text-grey-7">Original Dimensions:</div>
                                    <div class="text-body2">{{ originalWidth }} × {{ originalHeight }} px</div>
                                </div>
                                <div class="info-item">
                                    <div class="text-caption text-grey-7">Resized Dimensions:</div>
                                    <div class="text-body2">{{ resizedWidth }} × {{ resizedHeight }} px</div>
                                </div>
                                <div class="info-item">
                                    <div class="text-caption text-grey-7">Original Size:</div>
                                    <div class="text-body2">{{ formatBytes(originalFileSize) }}</div>
                                </div>
                                <div class="info-item">
                                    <div class="text-caption text-grey-7">PNG Size:</div>
                                    <div class="text-body2">{{ formatBytes(resizedPngSize) }}</div>
                                </div>
                                <div class="info-item">
                                    <div class="text-caption text-grey-7">Storage Cost:</div>
                                    <div class="text-body2">~{{ formatStorageCost(resizedPngSize) }}</div>
                                </div>
                            </div>
                        </q-card-section>
                    </q-card>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
export default {
    name: 'ImageSelector',
    props: {
        vectorId: {
            type: String,
            default: null,
        },
    },
    emits: ['file-selected', 'preview-url', 'resized-image'],
    data() {
        return {
            testV: 50,

            selectedFile: null,
            previewUrl: null,
            resizedPreviewUrl: null,
            originalImage: null,
            sizePercentage: 100,
            originalWidth: 0,
            originalHeight: 0,
            resizedWidth: 0,
            resizedHeight: 0,
            originalFileSize: 0,
            resizedPngSize: 0,
            debounceTimeout: null,
            isFitting: false,
            loadingSample: false,
            isImageLoading: false,
            applyingFilter: false,
        }
    },
    computed: {
        generateButtonLabel() {
            if (this.vectorId) {
                return 'Add Generated Sample Image';
            }
            return 'or Generate Sample Image';
        },
    },
    watch: {
        sizePercentage() {
            this.onSizeChange();
        },
    },
    methods: {
        onFileSelected(file) {
            if (!file) {
                this.resetState();
                return;
            }

            // Validate file type
            if (!file.type.startsWith('image/')) {
                this.$q.notify({
                    type: 'negative',
                    message: 'Please select a valid image file',
                });
                this.selectedFile = null;
                return;
            }

            this.originalFileSize = file.size;

            // Create preview URL and load image
            const reader = new FileReader();
            reader.onload = (e) => {
                this.previewUrl = e.target.result;
                this.loadImage(e.target.result);
            };
            reader.readAsDataURL(file);

            this.$emit('file-selected', file);
        },

        loadImage(dataUrl) {
            this.isImageLoading = true;
            const img = new Image();
            img.onload = () => {
                this.originalImage = img;
                this.originalWidth = img.width;
                this.originalHeight = img.height;
                // this.sizePercentage = 100;
                this.fitToSize(100 * 1024);
            };
            img.onerror = () => {
                this.isImageLoading = false;
                this.$q.notify({
                    type: 'negative',
                    message: 'Failed to load image',
                });
            };
            img.src = dataUrl;
        },

        onSizeChange() {
            setTimeout(() => {
                if (!this.originalImage) return;

                try {
                    // Clear existing timeout
                    if (this.debounceTimeout) {
                        clearTimeout(this.debounceTimeout);
                    }

                    // Update dimensions immediately for visual feedback
                    const scale = this.sizePercentage / 100;
                    this.resizedWidth = Math.round(this.originalWidth * scale);
                    this.resizedHeight = Math.round(this.originalHeight * scale);

                    // Debounce the actual image resize operation
                    this.debounceTimeout = setTimeout(() => {
                        this.resizeImage();
                    }, 300);
                } catch (error) {
                    console.error('Error during size change:', error);
                }
            }, 10);
        },

        resizeImage() {
            if (!this.originalImage) return;

            this.isImageLoading = true;
            console.log('Resizing image to', this.sizePercentage + '%');

            // Use setTimeout to allow UI to update before heavy processing
            setTimeout(() => {
                const scale = this.sizePercentage / 100;
                this.resizedWidth = Math.round(this.originalWidth * scale);
                this.resizedHeight = Math.round(this.originalHeight * scale);

                // Create canvas for resizing
                const canvas = document.createElement('canvas');
                canvas.width = this.resizedWidth;
                canvas.height = this.resizedHeight;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(this.originalImage, 0, 0, this.resizedWidth, this.resizedHeight);

                // Convert to PNG and get data URL
                const resizedDataUrl = canvas.toDataURL('image/png');
                this.resizedPreviewUrl = resizedDataUrl;

                // Calculate PNG byte size
                // Data URL format: data:image/png;base64,<base64-data>
                const base64Data = resizedDataUrl.split(',')[1];
                this.resizedPngSize = Math.round((base64Data.length * 3) / 4);

                // Emit the resized image data
                this.$emit('preview-url', resizedDataUrl);
                this.$emit('resized-image', {
                    dataUrl: resizedDataUrl,
                    width: this.resizedWidth,
                    height: this.resizedHeight,
                    sizeBytes: this.resizedPngSize,
                });

                this.isImageLoading = false;

                console.log('Resizing image to', 'done');
            }, 10);
        },

        resetState() {
            this.previewUrl = null;
            this.resizedPreviewUrl = null;
            this.originalImage = null;
            // this.sizePercentage = 100;
            this.originalWidth = 0;
            this.originalHeight = 0;
            this.resizedWidth = 0;
            this.resizedHeight = 0;
            this.originalFileSize = 0;
            this.resizedPngSize = 0;
            this.isImageLoading = false;
            this.$emit('file-selected', null);
            this.$emit('preview-url', null);
            this.$emit('resized-image', null);
        },

        formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
        },

        formatStorageCost(bytes) {
            if (bytes === 0) return '0 SUI';
            const sizeInKB = bytes / 1024;
            const storagePerKB = 0.008;
            return (sizeInKB * storagePerKB).toFixed(6) + ' SUI';
        },

        async fitToSize(targetBytes) {
            if (!this.originalImage) return;

            this.isFitting = true;

            // Clear any pending debounce
            if (this.debounceTimeout) {
                clearTimeout(this.debounceTimeout);
            }

            try {
                // Binary search to find the optimal size
                let minPercent = 1;
                let maxPercent = 100;
                let bestPercent = 100;

                // First check if current size is already under target
                this.sizePercentage = 100;
                await this.delay(200);
                const currentSize = await this.calculatePngSize(100);

                if (currentSize <= targetBytes) {
                    this.resizeImage();
                    this.$q.notify({
                        type: 'positive',
                        message: `Image already fits! (${this.formatBytes(currentSize)})`,
                        timeout: 2000,
                    });
                    this.isFitting = false;
                    return;
                }

                // Binary search for optimal percentage with visual updates
                while (maxPercent - minPercent > 1) {
                    const midPercent = Math.floor((minPercent + maxPercent) / 2);

                    // Update slider visually
                    this.sizePercentage = midPercent;

                    // Wait to show the update
                    await this.delay(200);

                    const size = await this.calculatePngSize(midPercent);

                    if (size <= targetBytes) {
                        bestPercent = midPercent;
                        minPercent = midPercent;
                    } else {
                        maxPercent = midPercent;
                    }
                }

                // Set the found percentage and resize
                this.sizePercentage = bestPercent;
                await this.delay(200);
                this.resizeImage();
                await this.delay(200);

                this.$q.notify({
                    type: 'positive',
                    message: `Image resized to ${bestPercent}% (${this.formatBytes(this.resizedPngSize)})`,
                    timeout: 2000,
                });
            } catch (error) {
                this.$q.notify({
                    type: 'negative',
                    message: 'Error fitting image to target size',
                });
            } finally {
                this.isFitting = false;
            }
        },

        delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        },

        applyColorfulPastelFilter(ctx, canvas) {
            const { width, height } = canvas;

            // Helper to generate random pastel colors
            const randomPastelRGBA = () => {
                const hue = Math.floor(Math.random() * 360);
                const saturation = 60 + Math.floor(Math.random() * 30); // 60-90%
                const lightness = 75 + Math.floor(Math.random() * 15);  // 75-90%
                const alpha = 0.75 + Math.random() * 0.15; // 0.75-0.9

                // Convert HSL to RGB for rgba
                const h = hue / 360;
                const s = saturation / 100;
                const l = lightness / 100;

                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1;
                    if (t > 1) t -= 1;
                    if (t < 1/6) return p + (q - p) * 6 * t;
                    if (t < 1/2) return q;
                    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                    return p;
                };

                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                const r = Math.round(hue2rgb(p, q, h + 1/3) * 255);
                const g = Math.round(hue2rgb(p, q, h) * 255);
                const b = Math.round(hue2rgb(p, q, h - 1/3) * 255);

                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            };

            // 1. Grab original image (your Sui logo on white)
            const original = ctx.getImageData(0, 0, width, height);

            // 2. Create offscreen canvas for pastel blobs
            const off = document.createElement('canvas');
            off.width = width;
            off.height = height;
            const octx = off.getContext('2d');

            // White base (so blending is predictable)
            octx.fillStyle = '#ffffff';
            octx.fillRect(0, 0, width, height);

            // --- pastel blob helper ---
            function pastelBlob(x, y, r, color) {
                const g = octx.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, color);
                g.addColorStop(1, 'rgba(255, 255, 255, 0)');
                octx.fillStyle = g;
                octx.beginPath();
                octx.arc(x, y, r, 0, Math.PI * 2);
                octx.fill();
            }

            // Slight blur for everything we draw
            octx.filter = 'blur(70px)';

            // 3. Draw multiple pastel blobs with random colors and positions
            const d = Math.max(width, height);
            const numBlobs = 5 + Math.floor(Math.random() * 3); // 5-7 blobs

            for (let i = 0; i < numBlobs; i++) {
                const x = width * (0.1 + Math.random() * 0.8);   // 10-90% of width
                const y = height * (0.1 + Math.random() * 0.8);  // 10-90% of height
                const r = d * (0.2 + Math.random() * 0.55);      // 20-75% of max dimension
                const color = randomPastelRGBA();

                pastelBlob(x, y, r, color);
            }

            // 4. Get pastel overlay pixels
            const pastel = octx.getImageData(0, 0, width, height);

            const origData = original.data;
            const pastelData = pastel.data;

            // 5. Blend: only apply to (almost) white background pixels
            for (let i = 0; i < origData.length; i += 4) {
                const r = origData[i];
                const g = origData[i + 1];
                const b = origData[i + 2];

                const pr = pastelData[i];
                const pg = pastelData[i + 1];
                const pb = pastelData[i + 2];

                // detect "whiteness" (we want bright, low-saturation areas)
                const brightness = (r + g + b) / 3;
                // 0 when <= 220, 1 when >= 255
                const t = Math.min(1, Math.max(0, (brightness - 220) / 35));

                if (t > 0) {
                    const mix = 0.8 * t; // max pastel strength (0.8), fades if less white

                    origData[i]     = r * (1 - mix) + pr * mix;
                    origData[i + 1] = g * (1 - mix) + pg * mix;
                    origData[i + 2] = b * (1 - mix) + pb * mix;
                    // alpha stays 255
                }
            }

            // 6. Put final pixels back
            ctx.putImageData(original, 0, 0);
        },

        async applyFilter() {
            this.applyingFilter = true;

            try {
                // Fetch the sample image
                const response = await fetch('/sample_image.png');

                if (!response.ok) {
                    throw new Error('Failed to load sample image');
                }

                // Convert to blob
                const blob = await response.blob();

                // Create a File object from the blob
                const file = new File([blob], 'sample_image.png', { type: blob.type });

                // Read the file as data URL
                const reader = new FileReader();
                reader.onload = (e) => {
                    const dataUrl = e.target.result;

                    // Load the image
                    const img = new Image();
                    img.onload = () => {
                        // Set original image properties
                        this.originalImage = img;
                        this.originalWidth = img.width;
                        this.originalHeight = img.height;
                        this.originalFileSize = blob.size;

                        // Calculate initial size (we'll resize to fit 100KB later)
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;

                        const ctx = canvas.getContext('2d');

                        // Draw the image
                        ctx.drawImage(img, 0, 0, img.width, img.height);

                        // Apply the soft filter
                        this.applyColorfulPastelFilter(ctx, canvas);

                        // Convert to PNG and get data URL
                        const filteredDataUrl = canvas.toDataURL('image/png');

                        // Update the original image to the filtered version
                        const filteredImg = new Image();
                        filteredImg.onload = () => {
                            this.originalImage = filteredImg;
                            this.previewUrl = filteredDataUrl;
                            this.selectedFile = file;

                            // Emit file selected
                            this.$emit('file-selected', file);

                            // Now fit to 100KB
                            this.fitToSize(100 * 1024).then(() => {
                                this.applyingFilter = false;

                                this.$q.notify({
                                    type: 'positive',
                                    message: 'Sample image loaded and filter applied',
                                    timeout: 2000,
                                });
                            });
                        };
                        filteredImg.src = filteredDataUrl;
                    };
                    img.onerror = () => {
                        throw new Error('Failed to load image');
                    };
                    img.src = dataUrl;
                };
                reader.onerror = () => {
                    throw new Error('Failed to read file');
                };
                reader.readAsDataURL(blob);
            } catch (error) {
                console.error('Error applying filter:', error);
                this.$q.notify({
                    type: 'negative',
                    message: 'Failed to load sample image and apply filter',
                });
                this.applyingFilter = false;
            }
        },

        async loadSampleImage() {
            this.loadingSample = true;

            try {
                // Fetch the image from the public path
                const response = await fetch('/sample_image.png');

                if (!response.ok) {
                    throw new Error('Failed to load sample image');
                }

                // Convert to blob
                const blob = await response.blob();

                // Create a File object from the blob
                const file = new File([blob], 'logo.png', { type: blob.type });

                // Set it as the selected file
                this.selectedFile = file;
                this.onFileSelected(file);

                this.$q.notify({
                    type: 'positive',
                    message: 'Sample image loaded successfully',
                    timeout: 2000,
                });
            } catch (error) {
                console.error('Error loading sample image:', error);
                this.$q.notify({
                    type: 'negative',
                    message: 'Failed to load sample image from /logo.png',
                    timeout: 3000,
                });
            } finally {
                this.loadingSample = false;
            }
        },

        calculatePngSize(percentage) {
            return new Promise((resolve) => {
                const scale = percentage / 100;
                const width = Math.round(this.originalWidth * scale);
                const height = Math.round(this.originalHeight * scale);

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(this.originalImage, 0, 0, width, height);

                const dataUrl = canvas.toDataURL('image/png');
                const base64Data = dataUrl.split(',')[1];
                const sizeBytes = Math.round((base64Data.length * 3) / 4);

                resolve(sizeBytes);
            });
        },
    },
    beforeUnmount() {
        // Clear debounce timeout
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }

        // Clean up object URLs if they exist
        if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(this.previewUrl);
        }
        if (this.resizedPreviewUrl && this.resizedPreviewUrl.startsWith('blob:')) {
            URL.revokeObjectURL(this.resizedPreviewUrl);
        }
    },
}
</script>

<style scoped>
.image-selector {
    width: 100%;
}

.info-card {
    height: 200px;
    padding: 0px;
}

.info-card .q-card-section {
    padding: 0px;
}

.info-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    height: 100%;
}

.info-item {
    padding: 8px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 4px;
    background-color: rgba(0, 0, 0, 0.02);
}

.preview-grid {
    position: relative;
    border: 2px solid var(--q-primary);
    border-radius: 8px;
    overflow: hidden;
    background-color: rgba(0, 0, 0, 0.05);
    height: 200px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.preview-image {
    width: 100%;
    max-height: 200px;
    display: block;
    object-fit: contain;
}
</style>

<template>
    <!-- Sample EndlessVectors -->
    <q-card flat bordered class="q-mb-md" v-if="sampleVectors.length > 0">
        <q-card-section>
            <div class="row items-center q-mb-md">
                <div class="text-h6">Sample EndlessVectors</div>
                <q-chip
                    :color="isTestnet ? 'orange' : 'green'"
                    text-color="white"
                    size="sm"
                    class="q-ml-sm"
                >
                    {{ isTestnet ? 'Testnet' : 'Mainnet' }}
                </q-chip>
            </div>

            <q-list bordered separator>
                <EndlessVectorListItem
                    v-for="vectorId in sampleVectors"
                    :key="vectorId"
                    :vectorId="vectorId"
                    :shouldInitialize="initializingVectorIds.has(vectorId)"
                    :owned="false"
                    @vector-loaded="onVectorLoaded"
                    @add-image="$emit('add-image', $event)"
                />
            </q-list>
        </q-card-section>
    </q-card>

    <q-card flat bordered>
        <q-card-section>
            <div class="row items-center justify-between q-mb-md">
                <div class="text-h6">Owned EndlessVectors</div>
                <q-btn
                    color="positive"
                    icon="add"
                    label="New"
                    size="sm"
                    @click="$emit('new-vector')"
                >
                    <q-tooltip>Create a new vector</q-tooltip>
                </q-btn>
            </div>

            <!-- Not connected state -->
            <div v-if="!isConnected" class="text-center q-pa-lg">
                <q-icon name="account_circle" size="64px" color="grey-5" class="q-mb-md" />
                <div class="text-body1 text-grey-7">
                    Please connect your wallet to view your Endless Vectors
                </div>
            </div>

            <!-- Loading state -->
            <div v-else-if="isLoading" class="text-center q-pa-lg">
                <q-spinner color="primary" size="50px" />
                <div class="q-mt-md text-grey-7">Loading your vectors...</div>
            </div>

            <!-- Empty state -->
            <div v-else-if="vectors.length === 0" class="text-center q-pa-lg">
                <q-icon name="inbox" size="64px" color="grey-5" class="q-mb-md" />
                <div class="text-body1 text-grey-7">
                    You don't have any Endless Vectors yet
                </div>
                <div class="text-caption text-grey-6 q-mt-sm">
                    Upload an image to create your first vector
                </div>
            </div>

            <!-- Vectors list -->
            <div v-else>
                <div class="q-mb-md text-caption text-grey-7">
                    Found {{ vectors.length }} vector{{ vectors.length > 1 ? 's' : '' }}
                </div>

                <q-list bordered separator>
                    <EndlessVectorListItem
                        v-for="vectorId in vectors"
                        :key="vectorId"
                        :vectorId="vectorId"
                        :shouldInitialize="initializingVectorIds.has(vectorId)"
                        owned
                        @vector-updated="loadVectors"
                        @vector-loaded="onVectorLoaded"
                        @add-image="$emit('add-image', $event)"
                    />
                </q-list>
            </div>
        </q-card-section>

        <q-card-actions v-if="isConnected && !isLoading">
            <q-btn
                flat
                color="primary"
                icon="refresh"
                label="Refresh"
                @click="loadVectors"
                :loading="isLoading"
            />
        </q-card-actions>
    </q-card>

</template>

<script>
import EndlessVector from '@fizzyflow/endless-vector';
import ids from '@fizzyflow/endless-vector/ids.js';
import EndlessVectorListItem from './EndlessVectorListItem.vue';


export default {
    name: 'EndlessVectorList',
    components: {
        EndlessVectorListItem,
    },
    emits: ['add-image', 'new-vector'],
    data() {
        return {
            vectors: [],
            isLoading: false,
            sampleVectors: [],
            initializingVectorIds: new Set(), // Track which vectors should initialize
        }
    },
    computed: {
        isConnected() {
            return this.$store.sui && this.$store.sui.connectedChain && this.$store.sui.address;
        },
        connectionId() {
            return this.$store.sui?.connectionId;
        },
        isTestnet() {
            const chain = this.$store.sui?.connectedChain;
            return chain && chain.includes('testnet');
        },
        packageId() {
            const chain = this.$store.sui?.connectedChain;
            if (!chain) return null;

            const chainName = chain.includes('testnet') ? 'testnet' : 'mainnet';
            return ids[chainName]?.packageId;
        },
        originalPackageId() {
            const chain = this.$store.sui?.connectedChain;
            if (!chain) return null;

            const chainName = chain.includes('testnet') ? 'testnet' : 'mainnet';
            return ids[chainName]?.originalPackageId;
        },
    },
    watch: {
        connectionId: {
            immediate: true,
            handler(newVal, oldVal) {
                if (newVal && newVal !== oldVal) {
                    this.loadVectors();
                    this.loadSampleVectors();
                    
                } else if (!newVal) {
                    this.vectors = [];
                    this.sampleVectors = [];
                }
            }
        }
    },
    methods: {
        async loadSampleVectors() {
            if (!this.packageId) {
                this.sampleVectors = [];
                return;
            }

            if (this.isTestnet) {
                this.sampleVectors.push('0xba385ffe0ffd68ec0e0f25810b342f4fc9cf2b7b2b2710f33c3834ff6d18b9ac');
            } else {
                this.sampleVectors.push('0x004fa4cb35d5c7a835d281ee883ea7ed1f7f110dda9aac28001565bd2b714474');
            }


            // Initialize the first sample vector
            this.initializeNextVector();
        },
        initializeNextVector() {
            // Get all vectors (owned + sample)
            const allVectors = [...this.vectors, ...this.sampleVectors];

            // Find the next vector that hasn't been initialized yet
            for (const vectorId of allVectors) {
                if (!this.initializingVectorIds.has(vectorId)) {
                    this.initializingVectorIds.add(vectorId);
                    // Trigger reactivity by creating a new Set
                    this.initializingVectorIds = new Set(this.initializingVectorIds);
                    this.$log.info('Initializing vector:', vectorId);
                    return;
                }
            }

            this.$log.info('All vectors initialized');
        },
        onVectorLoaded(data) {
            this.$log.info('Vector loaded:', data);

            // Initialize the next vector
            this.initializeNextVector();
        },
        async loadVectors() {
            if (!this.isConnected || !this.packageId) {
                this.vectors = [];
                return;
            }

            this.vectors = [];
            this.initializingVectorIds = new Set(); // Clear initialization state
            this.isLoading = true;

            try {
                const address = this.$store.sui.address;
                const vectorType = `${this.originalPackageId}::endless_vector::EndlessVector`;

                this.$log.info('Fetching owned EndlessVector objects for', address, 'with type', vectorType);

                // Query for owned objects of type EndlessVector
                const ownedObjects = await this.$store.sui.suiMaster.client.getOwnedObjects({
                    owner: address,
                    filter: {
                        StructType: vectorType,
                    },
                    options: {
                        showContent: true,
                        showType: true,
                    },
                });

                this.$log.info('Found', ownedObjects.data.length, 'EndlessVector objects');

                // Create EndlessVector instances and initialize them
                ownedObjects.data.forEach((obj) => {
                    this.vectors.push(obj.data.objectId);
                });

                this.$q.notify({
                    type: 'positive',
                    message: `Found ${this.vectors.length} vector${this.vectors.length !== 1 ? 's' : ''}`,
                    timeout: 2000,
                });

                // Start sequential initialization with the first vector
                if (this.vectors.length > 0) {
                    this.initializeNextVector();
                }
            } catch (error) {
                console.error('Error loading vectors:', error);
                this.$q.notify({
                    type: 'negative',
                    message: `Failed to load vectors: ${error.message}`,
                    timeout: 5000,
                });
                this.vectors = [];
            } finally {
                this.isLoading = false;
            }
        },
    },
}
</script>

<template>

    <div  class="relative-position" style="min-height: 50vh;">

        <q-inner-loading
            showing
            color="primary"
            label="Connecting to Sui...."
            label-class="text-primary"
            label-style="font-size: 1.1em"
            v-if="!isConnectionReady"
            />

        <div v-if="isConnectionReady" class="q-pa-md">

<q-banner class="bg-primary text-white">
This sample dApp demonstrates how to store images inside a Sui object using the endlessVector 
smart contract and the <a href="https://github.com/FizzyFlow/endless_vector" target="_blank">JS/TS SDK</a>. 
The contract enables storing 
vector&lt;vector&lt;u8&gt;&gt; on the Sui blockchain without being limited by Sui’s 
default object <a href="https://move-book.com/guides/building-against-limits/" target="_blank">size restrictions</a>.
</q-banner>

            <div class="row" style="min-height: 80vh">
                <div class="col-12 col-md-6 q-py-md q-pr-xs">
                    <EndlessVectorList
                        ref="vectorList"
                        @add-image="onAddImage"
                        @new-vector="onNewVector"
                    />
                </div>

                <div class="col-12 col-md-6 q-py-md q-pl-xs">
                    <EndlessVectorImageUploader
                        :vector-id="selectedVectorId"
                        @upload-success="onUploadSuccess"
                        @upload-error="onUploadError"
                    />
                </div>
            </div>

        </div>

    </div>

</template>
<script>

import EndlessVectorImageUploader from '../../../shared/components/CommonSui/EndlessVectorImageUploader.vue';
import EndlessVectorList from '../../../shared/components/CommonSui/EndlessVectorList.vue';

export default {
	name: 'Home',
    path: '/',
	props: {
	},
    components: {
        EndlessVectorImageUploader,
        EndlessVectorList,
    },
	data() {
		return {
            chain: 'sui:mainnet',
            siteId: null,
            uploadedVectorId: null,
            selectedVectorId: null, // Vector ID to append images to
		}
	},
	methods: {
        onNewVector() {
            this.selectedVectorId = null;
        },
        onAddImage(vectorId) {
            this.selectedVectorId = vectorId;
        },
        onUploadSuccess(data) {
            this.uploadedVectorId = data.vectorId;
            console.log('Upload successful! Vector ID:', data.vectorId);
            console.log('Image data:', data.imageData);

            // Clear the selected vector ID after successful upload
            this.selectedVectorId = null;

            // Refresh the vector list after successful upload
            this.$q.notify({
                type: 'info',
                message: 'Refreshing vector list...',
                timeout: 1500,
            });

            setTimeout(() => {
                if (this.$refs.vectorList && this.$refs.vectorList.loadVectors) {
                    this.$refs.vectorList.loadVectors();
                }
            }, 1500);
        },
        onUploadError(error) {
            console.error('Upload error:', error);
        },
	},
    watch: {
    },
    computed: {
        connectionId() {
            if ( this.$store.sui && this.$store.sui.connectionId ) {
                return this.$store.sui.connectionId;
            }
            return null;
        },
        isConnectionReady() {
            if (this.$store.sui && this.$store.sui.connectedChain) {
                return true;
            }
            return false;
        },
    },
    beforeMount() {
    },
    mounted() {
    },
}
</script>

<!-- Add "scoped" attribute to limit CSS to this component only -->
<style>


</style>


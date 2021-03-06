'use strict';

const mapnik = require('@carto/mapnik');
const Renderer = require('./renderer');
const BaseAdaptor = require('../base_adaptor');
const layersFilter = require('../../utils/layer_filter');

const EMPTY_IMAGE_BUFFER = new mapnik.Image(256, 256).encodeSync('png');
const NAME = 'blend';

class BlendFactory {
    constructor (rendererFactory) {
        this.rendererFactory = rendererFactory;
    }

    getName () {
        return NAME;
    }

    supportsFormat (format) {
        return format === 'png';
    }

    getAdaptor (renderer, format, onTileErrorStrategy) {
        return new BaseAdaptor(renderer, format, onTileErrorStrategy);
    }

    getRenderer (mapConfig, format, options, callback) {
        const layer = options.layer;
        const params = options.params;
        const limits = options.limits;

        let filteredLayers;
        try {
            filteredLayers = layersFilter(mapConfig, layer);
        } catch (err) {
            return callback(err);
        }

        if (!filteredLayers.length) {
            return callback(new Error('No renderers'));
        }

        let hasMapnikLayer = false;
        const layerRenderers = filteredLayers.map(layerIndex => {
            return new Promise((resolve, reject) => {
                const rendererParams = Object.assign({}, params, {layer: layerIndex});
                const layerType = mapConfig.layerType(layerIndex);
                const isMapnikLayer = layerType === 'mapnik';

                if (isMapnikLayer && hasMapnikLayer) {
                    return resolve();
                }

                if (isMapnikLayer) {
                    rendererParams.layer = getMapnikLayersFromFilter(mapConfig, filteredLayers);
                }

                const rendererOptions = { limits };

                // Avoid failing because of timeouts or 404/errors in http layers
                rendererOptions.onTileErrorStrategy = layerType === 'http' ?
                    onTileErrorStrategyHttpRenderer :
                    onTileErrorStrategy;

                if (isMapnikLayer) {
                    hasMapnikLayer = true;
                }

                this.rendererFactory.getRenderer(mapConfig, rendererParams, rendererOptions, (err, renderer) => {
                    if (err) {
                        return reject(err);
                    }

                    return resolve(renderer);
                });
            });
        });

        return Promise.all(layerRenderers)
            .then(renderers => {
                if (!renderers.length) {
                    throw new Error('No renderers');
                }

                renderers = renderers.filter(renderer => !!renderer);

                return callback(null, new Renderer(renderers));
            })
            .catch(err => callback(err));
    }
}

module.exports = BlendFactory;
module.exports.NAME = NAME;

function onTileErrorStrategyHttpRenderer (err, tile, headers, stats, format, callback) {
    if (err.code === 'ETIMEDOUT') {
        return callback(err, tile, headers, stats);
    }
    return callback(null, EMPTY_IMAGE_BUFFER, {'Content-Type': 'image/png'}, stats || {});
}

function onTileErrorStrategy (err, tile, headers, stats, format, callback) {
    if (err.message && err.message.match(/coordinates out of range/i)) {
        return callback(null, EMPTY_IMAGE_BUFFER, {'Content-Type': 'image/png'}, stats || {});
    }

    return callback(err, tile, headers, stats);
}

function getMapnikLayersFromFilter(mapConfig, filteredLayers) {
    return filteredLayers.filter(layerIndex => mapConfig.layerType(layerIndex) === 'mapnik').join(',');
}

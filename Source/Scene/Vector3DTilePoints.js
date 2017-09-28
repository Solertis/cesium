define([
        '../Core/Cartesian3',
        '../Core/Color',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/DistanceDisplayCondition',
        '../Core/Ellipsoid',
        '../Core/NearFarScalar',
        '../Core/Rectangle',
        '../Core/TaskProcessor',
        '../ThirdParty/when',
        './BillboardCollection',
        './Cesium3DTilePointFeature',
        './HorizontalOrigin',
        './LabelCollection',
        './LabelStyle',
        './PolylineCollection',
        './VerticalOrigin'
    ], function(
        Cartesian3,
        Color,
        defined,
        defineProperties,
        destroyObject,
        DistanceDisplayCondition,
        Ellipsoid,
        NearFarScalar,
        Rectangle,
        TaskProcessor,
        when,
        BillboardCollection,
        Cesium3DTilePointFeature,
        HorizontalOrigin,
        LabelCollection,
        LabelStyle,
        PolylineCollection,
        VerticalOrigin) {
    'use strict';

    /**
     * Renders a batch of points or billboards and labels.
     *
     * @alias Vector3DTilePoints
     * @constructor
     *
     * @param {Object} options An object with following properties:
     * @param {Float32Array|Uint16Array} options.positions The positions of the polygons.
     * @param {Number} options.minimumHeight The minimum height of the terrain covered by the tile.
     * @param {Number} options.maximumHeight The maximum height of the terrain covered by the tile.
     * @param {Rectangle} options.rectangle The rectangle containing the tile.
     * @param {Cesium3DTileBatchTable} options.batchTable The batch table for the tile containing the batched polygons.
     * @param {Number[]} options.batchIds The batch ids for each polygon.
     *
     * @private
     */
    function Vector3DTilePoints(options) {
        // released after the first update
        this._positions = options.positions;

        this._batchTable = options.batchTable;
        this._batchIds = options.batchIds;

        this._rectangle = options.rectangle;
        this._minHeight = options.minimumHeight;
        this._maxHeight = options.maximumHeight;

        this._billboardCollection = undefined;
        this._labelCollection = undefined;
        this._polylineCollection = undefined;

        this._verticesPromise = undefined;
        this._packedBuffer = undefined;

        this._ready = false;
        this._readyPromise = when.defer();
        this._resolvedPromise = false;
    }

    defineProperties(Vector3DTilePoints.prototype, {
        /**
         * Gets the number of points.
         *
         * @memberof Vector3DTilePoints.prototype
         *
         * @type {Number}
         * @readonly
         */
        pointsLength : {
            get : function() {
                return this._billboardCollection.length;
            }
        },

        /**
         * Gets the texture atlas memory in bytes.
         *
         * @memberof Vector3DTilePoints.prototype
         *
         * @type {Number}
         * @readonly
         */
        texturesByteLength : {
            get : function() {
                var billboardSize = this._billboardCollection.textureAtlas.texture.sizeInBytes;
                var labelSize = this._labelCollection._textureAtlas.texture.sizeInBytes;
                return billboardSize + labelSize;
            }
        },

        /**
         * Gets a promise that resolves when the primitive is ready to render.
         * @memberof Vector3DTilePoints.prototype
         * @type {Promise}
         * @readonly
         */
        readyPromise : {
            get : function() {
                return this._readyPromise.promise;
            }
        }
    });

    function packBuffer(points, ellipsoid) {
        var rectangle = points._rectangle;
        var minimumHeight = points._minHeight;
        var maximumHeight = points._maxHeight;

        var packedLength = 2 + Rectangle.packedLength + Ellipsoid.packedLength;
        var packedBuffer = new Float64Array(packedLength);

        var offset = 0;
        packedBuffer[offset++] = minimumHeight;
        packedBuffer[offset++] = maximumHeight;

        Rectangle.pack(rectangle, packedBuffer, offset);
        offset += Rectangle.packedLength;

        Ellipsoid.pack(ellipsoid, packedBuffer, offset);

        return packedBuffer;
    }

    var createVerticesTaskProcessor = new TaskProcessor('createVectorTilePoints');
    var scratchPosition = new Cartesian3();

    function createPoints(points, ellipsoid) {
        if (defined(points._billboardCollection)) {
            return;
        }

        var positions;
        if (!defined(points._verticesPromise)) {
            positions = points._positions;
            var packedBuffer = points._packedBuffer;

            if (!defined(packedBuffer)) {
                // Copy because they may be the views on the same buffer.
                positions = points._positions = positions.slice();
                points._batchIds = points._batchIds.slice();

                packedBuffer = points._packedBuffer = packBuffer(points, ellipsoid);
            }

            var transferrableObjects = [positions.buffer, packedBuffer.buffer];
            var parameters = {
                positions : positions.buffer,
                packedBuffer : packedBuffer.buffer
            };

            var verticesPromise = points._verticesPromise = createVerticesTaskProcessor.scheduleTask(parameters, transferrableObjects);
            if (!defined(verticesPromise)) {
                // Postponed
                return;
            }

            when(verticesPromise, function(result) {
                points._positions = new Float64Array(result.positions);
                points._ready = true;
            });
        }

        if (points._ready && !defined(points._billboardCollection)) {
            positions = points._positions;
            var batchTable = points._batchTable;
            var batchIds = points._batchIds;

            var billboardCollection = points._billboardCollection = new BillboardCollection({batchTable : batchTable});
            var labelCollection = points._labelCollection = new LabelCollection({batchTable : batchTable});
            var polylineCollection = points._polylineCollection = new PolylineCollection();

            var numberOfPoints = positions.length / 3;
            for (var i = 0; i < numberOfPoints; ++i) {
                var id = batchIds[i];

                var position = Cartesian3.unpack(positions, i * 3, scratchPosition);

                var b = billboardCollection.add();
                b.position = position;
                b.verticalOrigin = VerticalOrigin.BOTTOM;
                b._batchIndex = id;

                var l = labelCollection.add();
                l.text = ' ';
                l.position = position;
                l.verticalOrigin = VerticalOrigin.BOTTOM;
                l._batchIndex = id;

                var p = polylineCollection.add();
                p.positions = [Cartesian3.clone(position), Cartesian3.clone(position)];
            }

            points._positions = undefined;
            points._packedBuffer = undefined;
        }
    }

    /**
     * Creates features for each point and places it at the batch id index of features.
     *
     * @param {Vector3DTileContent} content The vector tile content.
     * @param {Cesium3DTileFeature[]} features An array of features where the point features will be placed.
     */
    Vector3DTilePoints.prototype.createFeatures = function(content, features) {
        var billboardCollection = this._billboardCollection;
        var labelCollection = this._labelCollection;
        var polylineCollection = this._polylineCollection;

        var batchIds = this._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];

            var billboard = billboardCollection.get(i);
            var label = labelCollection.get(i);
            var polyline = polylineCollection.get(i);

            features[batchId] = new Cesium3DTilePointFeature(content, batchId, billboard, label, polyline);
        }
    };

    /**
     * Colors the entire tile when enabled is true. The resulting color will be (batch table color * color).
     *
     * @param {Boolean} enabled Whether to enable debug coloring.
     * @param {Color} color The debug color.
     */
    Vector3DTilePoints.prototype.applyDebugSettings = function(enabled, color) {
        // TODO
    };

    function clearStyle(polygons, features) {
        var batchIds = polygons._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            var feature = features[batchId];

            feature.show = true;
            feature.pointSize = Cesium3DTilePointFeature.defaultPointSize;
            feature.pointColor = Cesium3DTilePointFeature.defaultPointColor;
            feature.pointOutlineColor = Cesium3DTilePointFeature.defaultPointOutlineColor;
            feature.pointOutlineWidth = Cesium3DTilePointFeature.defaultPointOutlineWidth;
            feature.labelColor = Color.WHITE;
            feature.labelOutlineColor = Color.WHITE;
            feature.labelOutlineWidth = 1.0;
            feature.font = '30px sans-serif';
            feature.labelStyle = LabelStyle.FILL;
            feature.labelText = undefined;
            feature.backgroundColor = undefined;
            feature.backgroundPadding = undefined;
            feature.backgroundEnabled = false;
            feature.scaleByDistance = undefined;
            feature.translucencyByDistance = undefined;
            feature.distanceDisplayCondition = undefined;
            feature.heightOffset = 0.0;
            feature.anchorLineEnabled = false;
            feature.anchorLineColor = Color.WHITE;
            feature.image = undefined;
            feature.disableDepthTestDistance = 0.0;
            feature.origin = HorizontalOrigin.CENTER;
            feature.labelOrigin = HorizontalOrigin.LEFT;

            feature._setBillboardImage();
        }
    }

    var scratchColor = new Color();
    var scratchColor2 = new Color();
    var scratchColor3 = new Color();
    var scratchColor4 = new Color();
    var scratchColor5 = new Color();
    var scratchColor6 = new Color();

    /**
     * Apply a style to the content.
     *
     * @param {FrameState} frameState The frame state.
     * @param {Cesium3DTileStyle} style The style.
     * @param {Cesium3DTileFeature[]} features The array of features.
     */
    Vector3DTilePoints.prototype.applyStyle = function(frameState, style, features) {
        if (!defined(style)) {
            clearStyle(this, features);
            return;
        }

        var batchIds = this._batchIds;
        var length = batchIds.length;
        for (var i = 0; i < length; ++i) {
            var batchId = batchIds[i];
            var feature = features[batchId];

            if (defined(style.show)) {
                feature.show = style.show.evaluate(frameState, feature);
            }

            if (defined(style.pointSize)) {
                feature.pointSize = style.pointSize.evaluate(frameState, feature);
            }

            if (defined(style.pointColor)) {
                feature.pointColor = style.pointColor.evaluateColor(frameState, feature, scratchColor);
            }

            if (defined(style.pointOutlineColor)) {
                feature.pointOutlineColor = style.pointOutlineColor.evaluateColor(frameState, feature, scratchColor2);
            }

            if (defined(style.pointOutlineWidth)) {
                feature.pointOutlineWidth = style.pointOutlineWidth.evaluate(frameState, feature);
            }

            if (defined(style.labelColor)) {
                feature.labelColor = style.labelColor.evaluateColor(frameState, feature, scratchColor3);
            }

            if (defined(style.labelOutlineColor)) {
                feature.labelOutlineColor = style.labelOutlineColor.evaluateColor(frameState, feature, scratchColor4);
            }

            if (defined(style.labelOutlineWidth)) {
                feature.labelOutlineWidth = style.labelOutlineWidth.evaluate(frameState, feature);
            }

            if (defined(style.font)) {
                feature.font = style.font.evaluate(frameState, feature);
            }

            if (defined(style.labelStyle)) {
                feature.labelStyle = style.labelStyle.evaluate(frameState, feature);
            }

            if (defined(style.labelText)) {
                feature.labelText = style.labelText.evaluate(frameState, feature);
            } else {
                feature.labelText = undefined;
            }

            if (defined(style.backgroundColor)) {
                feature.backgroundColor = style.backgroundColor.evaluateColor(frameState, feature, scratchColor5);
            }

            if (defined(style.backgroundPadding)) {
                feature.backgroundPadding = style.backgroundPadding.evaluate(frameState, feature);
            }

            if (defined(style.backgroundEnabled)) {
                feature.backgroundEnabled = style.backgroundEnabled.evaluate(frameState, feature);
            }

            if (defined(style.scaleByDistance)) {
                var scaleByDistanceCart4 = style.scaleByDistance.evaluate(frameState, feature);
                feature.scaleByDistance = new NearFarScalar(scaleByDistanceCart4.x, scaleByDistanceCart4.y, scaleByDistanceCart4.z, scaleByDistanceCart4.w);
            } else {
                feature.scaleBydistance = undefined;
            }

            if (defined(style.translucencyByDistance)) {
                var translucencyByDistanceCart4 = style.translucencyByDistance.evaluate(frameState, feature);
                feature.translucencyByDistance = new NearFarScalar(translucencyByDistanceCart4.x, translucencyByDistanceCart4.y, translucencyByDistanceCart4.z, translucencyByDistanceCart4.w);
            } else {
                feature.translucencyByDistance = undefined;
            }

            if (defined(style.distanceDisplayCondition)) {
                var distanceDisplayConditionCart2 = style.distanceDisplayCondition.evaluate(frameState, feature);
                feature.distanceDisplayCondition = new DistanceDisplayCondition(distanceDisplayConditionCart2.x, distanceDisplayConditionCart2.y);
            } else {
                feature.distanceDisplayCondition = undefined;
            }

            if (defined(style.heightOffset)) {
                feature.heightOffset = style.heightOffset.evaluate(frameState, feature);
            }

            if (defined(style.anchorLineEnabled)) {
                feature.anchorLineEnabled = style.anchorLineEnabled.evaluate(frameState, feature);
            }

            if (defined(style.anchorLineColor)) {
                feature.anchorLineColor = style.anchorLineColor.evaluateColor(frameState, feature, scratchColor6);
            }

            if (defined(style.image)) {
                feature.image = style.image.evaluate(frameState, feature);
            } else {
                feature.image = undefined;
            }

            if (defined(style.disableDepthTestDistance)) {
                feature.disableDepthTestDistance = style.disableDepthTestDistance.evaluate(frameState, feature);
            }

            if (defined(style.origin)) {
                feature.origin = style.origin.evaluate(frameState, feature);
            }

            if (defined(style.labelOrigin)) {
                feature.labelOrigin = style.labelOrigin.evaluate(frameState, feature);
            }

            feature._setBillboardImage();
        }
    };

    /**
     * @private
     */
    Vector3DTilePoints.prototype.update = function(frameState) {
        createPoints(this, frameState.mapProjection.ellipsoid);

        if (!this._ready) {
            return;
        }

        this._polylineCollection.update(frameState);
        this._billboardCollection.update(frameState);
        this._labelCollection.update(frameState);

        if (!this._resolvedPromise) {
            this._readyPromise.resolve();
            this._resolvedPromise = true;
        }
    };

    /**
     * Returns true if this object was destroyed; otherwise, false.
     * <p>
     * If this object was destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
     * </p>
     *
     * @returns {Boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
     */
    Vector3DTilePoints.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
     * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
     * <p>
     * Once an object is destroyed, it should not be used; calling any function other than
     * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
     * assign the return value (<code>undefined</code>) to the object as done in the example.
     * </p>
     *
     * @returns {undefined}
     *
     * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
     */
    Vector3DTilePoints.prototype.destroy = function() {
        this._billboardCollection = this._billboardCollection && this._billboardCollection.destroy();
        this._labelCollection = this._labelCollection && this._labelCollection.destroy();
        this._polylineCollection = this._polylineCollection && this._polylineCollection.destroy();
        return destroyObject(this);
    };

    return Vector3DTilePoints;
});

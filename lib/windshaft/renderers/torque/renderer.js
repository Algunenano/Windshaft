'use strict';

const format = require('../../utils/format');
const Timer = require('../../stats/timer');
const debug = require('debug')('windshaft:renderer:torque');
const SubstitutionTokens = require('cartodb-query-tables').utils.substitutionTokens;

module.exports = class TorqueRenderer {
    constructor (layer, sql, attrs, options) {
        options = options || {};

        this.sql = sql;
        this.attrs = attrs;
        this.layer = layer;

        this.tile_size = options.tileSize || 256;
        this.tile_max_geosize = options.maxGeosize || 40075017; // earth circumference in webmercator 3857
        this.buffer_size = options.bufferSize || 0;
        this.tile_sql = options.tile_sql || defaultTileSQLTemplate();
    }

    /// API: renders a tile with the Renderer configuration
    /// @param x tile x coordinate
    /// @param y tile y coordinate
    /// @param z tile zoom
    /// callback: will be called when done using nodejs protocol (err, data)
    getTile (z, x, y, callback) {
        this.getTileData(this.sql, {x: x, y: y}, z, this.layer.options.sql, this.attrs, callback);
    }

    /// API: returns metadata for this renderer
    //
    /// Metadata for a torque layer is an object
    /// with the following elements:
    ///   - start  ??
    ///   - end    ??
    ///   - data_steps ??
    ///   - column_type ??
    ///
    /// TODO: document the meaning of each !
    ///
    getMetadata (callback) {
        const a = this.attrs;
        const meta = {
            start: a.start * 1000,
            end: a.end * 1000,
            steps: +a.steps,
            data_steps: a.data_steps >> 0,
            column_type: a.is_time ? 'date': 'number'
        };
        callback(null, meta);
    }

    getTileData (sql, coord, zoom, layer_sql, attrs, callback) {
        let column_conv = attrs.column;

        if(attrs.is_time) {
            column_conv = format("date_part('epoch', {column})", attrs);
        }

        const tile_size = this.tile_size;
        const buffer_size = this.buffer_size;
        const tile_max_geosize = this.tile_max_geosize;
        const geom_column = this.layer.options.geom_column || 'the_geom_webmercator';
        const geom_column_srid = this.layer.options.srid || 3857;

        function cdb_XYZ_Resolution(z) {
            const full_resolution = tile_max_geosize / tile_size;
            return full_resolution / Math.pow(2, z);
        }

        function cdb_XYZ_Extent(x, y, z) {
            const initial_resolution = cdb_XYZ_Resolution(0);
            const origin_shift = (initial_resolution * tile_size) / 2.0;

            const pixres = initial_resolution / Math.pow(2,z);
            const tile_geo_size = tile_size * pixres;

            const buffer = buffer_size / 2;

            const xmin = -origin_shift + x*tile_geo_size;
            const xmax = -origin_shift + (x+1)*tile_geo_size;

            // tile coordinate system is y-reversed so ymin is the top of the tile
            const ymin = origin_shift - y*tile_geo_size;
            const ymax = origin_shift - (y+1)*tile_geo_size;

            return {
                xmin: xmin,
                ymin: ymin,
                xmax: xmax,
                ymax: ymax,
                b_xmin: xmin - (pixres * buffer),
                b_ymin: ymin + (pixres * buffer),
                b_xmax: xmax + (pixres * buffer),
                b_ymax: ymax - (pixres * buffer),
                b_size: buffer / attrs.resolution
            };
        }

        const extent = cdb_XYZ_Extent(coord.x, coord.y, zoom);
        const xyz_resolution = cdb_XYZ_Resolution(zoom);

        layer_sql = SubstitutionTokens.replace(layer_sql, {
            bbox: format('ST_MakeEnvelope({xmin},{ymin},{xmax},{ymax},{srid})', { srid: geom_column_srid }, extent),
            // See https://github.com/mapnik/mapnik/wiki/ScaleAndPpi#scale-denominator
            scale_denominator: xyz_resolution / 0.00028,
            pixel_width: xyz_resolution,
            pixel_height: xyz_resolution
        });

        const query = format(this.tile_sql, {_sql: layer_sql}, {_stepFilter: stepFilter(attrs)}, attrs, {
            zoom: zoom,
            x: coord.x,
            y: coord.y,
            column_conv: column_conv,
            xyz_resolution: xyz_resolution,
            srid: geom_column_srid,
            gcol: geom_column
        }, extent);

        const timer = new Timer();
        timer.start('query');
        sql(query, function (err, data) {
            timer.end('query');
            if (err) {
                debug("Error running torque query " + query + ": " + err);
                if ( err.message ) {
                    err.message = "TorqueRenderer: " + err.message;
                }
                callback(err);
            } else {
                callback(null, data.rows, {'Content-Type': 'application/json'}, timer.getTimes());
            }
        });
    }
};

function stepFilter(attrs) {
    let sqlCondition = '';

    if (attrs.stepSelect !== undefined) {
        sqlCondition = "AND floor(({column_conv} - {start})/{step}) " +
            "BETWEEN {stepSelect} - {stepOffset} + 1 AND {stepSelect} ";
    }

    return sqlCondition;
}

function defaultTileSQLTemplate () {
    return `
        WITH par AS (
            WITH innerpar AS (
                SELECT
                    1.0/(({xyz_resolution})*{resolution}) as resinv,
                    ST_MakeEnvelope({b_xmin}, {b_ymin}, {b_xmax}, {b_ymax}, {srid}) as b_ext,
                    ST_MakeEnvelope({xmin}, {ymin}, {xmax}, {ymax}, {srid}) as ext
            )
            SELECT
                ({xyz_resolution})*{resolution} as res,
                innerpar.resinv as resinv,
                innerpar.b_ext as b_ext,
                st_xmin(innerpar.ext) as xmin,
                st_ymin(innerpar.ext) as ymin,
                round((st_xmax(innerpar.ext) - st_xmin(innerpar.ext))*innerpar.resinv) - 1 as maxx,
                round((st_ymax(innerpar.ext) - st_ymin(innerpar.ext))*innerpar.resinv) - 1 as maxy
            FROM innerpar
        )
        SELECT xx x__uint8,
            yy y__uint8,
            array_agg(c) vals__uint8,
            array_agg(d) dates__uint16
        FROM (
            select
                GREATEST(0 - {b_size}, LEAST(p.maxx + {b_size}, round((st_x(i.{gcol}) - p.xmin)*resinv))) as xx,
                GREATEST(0 - {b_size}, LEAST(p.maxy + {b_size}, round((st_y(i.{gcol}) - p.ymin)*resinv))) as yy,
                {countby} c,
                floor(({column_conv} - {start})/{step}) d
            FROM ({_sql}) i, par p
            WHERE i.{gcol} && p.b_ext {_stepFilter}
            GROUP BY xx, yy, d
        ) cte, par
        GROUP BY x__uint8, y__uint8
    `;
}
<?php

namespace App\Traits\Resources;

use Illuminate\Http\Resources\MergeValue;
use Illuminate\Support\Collection;

trait FilterableResource {
    /**
     * Set the fields to display.
     *
     * @param array<string, mixed> $attributes
     */
    protected function fields(array $attributes): array {
        return collect($attributes)
            ->reduce(function($carry, $value, $key) {
                if (is_null($carry)) {
                    return collect([$key => $value]);
                }

                /* @var Collection $carry */

                if ($value instanceof MergeValue) {
                    return $carry->merge($value->data);
                }

                return $carry->merge([$key => $value]);
            })
            ->only(array_keys(array_merge($this->resource->getAttributes(), $this->resource->getRelations())))
            ->toArray();
    }
}

<?php

namespace App\Http\Resources\Products;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin \App\Models\Products\Product */
class ProductResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'id' => $this->id,
            'name' => $this->name,
            'slug' => $this->slug,
            'user_id' => $this->user_id,
            'compatible_systems' => $this->compatible_systems,
            'compatible_versions' => $this->compatible_versions,
            'license' => $this->license,
            'access_requirements' => $this->access_requirements,
            'links' => $this->links,
            'supported_languages' => $this->supported_languages,
            'product_icon' => $this->product_icon,
            'product_banner' => $this->product_banner,
            'created_at' => $this->created_at,
            'updated_at' => $this->updated_at,
        ];
    }
}

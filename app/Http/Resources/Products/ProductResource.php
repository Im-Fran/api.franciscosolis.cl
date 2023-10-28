<?php

namespace App\Http\Resources\Products;

use App\Http\Resources\UserResource;
use App\Models\Products\Product;
use App\Traits\ResourceFilterable;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin Product */
class ProductResource extends JsonResource {
    use ResourceFilterable;

    public function toArray(Request $request): array {
        return $this->fields([
            'id' => $this->id,
            'name' => $this->name,
            'slug' => $this->slug,
            'owned_by_id' => $this->owned_by_id,
            'owned_by_type' => $this->owned_by_type,
            'owner' => new UserResource($this->whenLoaded('owner')),
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
        ]);
    }
}

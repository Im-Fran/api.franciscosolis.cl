<?php

namespace App\Models\Teams;

use App\Models\User;
use Cog\Contracts\Ownership\CanBeOwner;
use Illuminate\Database\Eloquent\Casts\AsCollection;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Spatie\Sluggable\HasSlug;
use Spatie\Sluggable\SlugOptions;

class Team extends Model implements CanBeOwner {
    use HasUlids,
        SoftDeletes,
        HasSlug,
        HasFactory;

    protected $fillable = [
        'user_id',
        'name',
        'slug',
        'bio',
        'website',
        'links',
        'emails',
    ];

    protected $casts = [
        'links' => AsCollection::class,
        'emails' => AsCollection::class,
    ];

    /* Stubs */
    public function getSlugOptions(): SlugOptions {
        return SlugOptions::create()
            ->generateSlugsFrom('name')
            ->saveSlugsTo('slug');
    }

    /* Relationships */
    public function user(): BelongsTo {
        return $this->belongsTo(User::class);
    }

    public function members(): BelongsToMany {
        return $this->belongsToMany(User::class, 'team_members', 'team_id', 'user_id');
    }
}
